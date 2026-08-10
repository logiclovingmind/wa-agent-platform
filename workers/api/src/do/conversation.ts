import { DurableObject } from "cloudflare:workers";
import {
  assertSingleReply,
  BLOCKED_REPLY,
  buildMessages,
  checkOutput,
  complete,
  costMicros,
  createOrgDb,
  createServiceClient,
  FALLBACK_REPLY,
  flagFromModel,
  HISTORY_LIMIT,
  isWindowOpen,
  prefilter,
  SAFE_REPLY,
  windowExpiresAt,
  type Completion,
  type OrgDb,
  type PromptTurn,
  type SafetyKind,
  type Sector,
} from "@wa/shared";
import type { Env } from "../env.js";
import { downloadMedia, sendTemplate, sendText, type SendTarget } from "../meta.js";

/** DO alarms retry with backoff; cron does not. That is why debounce lives here. */
export const DEBOUNCE_MS = 4_000;

/** Auto-return to the bot after this much human silence. */
export const HANDOFF_IDLE_MS = 30 * 60 * 1000;

const SEEN_LIMIT = 200;

export type HandoffState = "bot" | "requested" | "human" | "returned";

export interface InboundMessage {
  orgId: string;
  waAccountId: string;
  customerWaId: string;
  waMessageId: string;
  type: string;
  body: string | null;
  /** Graph media id, present on image/video/audio/document/sticker messages. */
  mediaId?: string | null;
  /** Epoch ms, from Meta's own timestamp rather than our clock. */
  sentAt: number;
}

/**
 * One instance per conversation, so per-conversation ordering and the handoff lock
 * are free: the runtime never runs two of these concurrently. Everything that must
 * happen exactly once for a conversation happens in here.
 */
export class ConversationDO extends DurableObject<Env> {
  #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;

    this.#sql.exec("create table if not exists kv (k text primary key, v text not null)");
    // Plain rowid, not AUTOINCREMENT: only the oldest rows are ever deleted, so ids
    // stay monotonic without the extra bookkeeping table.
    this.#sql.exec(`create table if not exists seen (
      id integer primary key,
      wa_message_id text not null unique,
      seen_at integer not null)`);
    this.#sql.exec(`create table if not exists pending (
      wa_message_id text primary key,
      type text not null,
      body text,
      sent_at integer not null)`);
    this.#sql.exec(`create table if not exists replies (
      inbound_wa_message_id text primary key,
      claimed_at integer not null)`);
  }

  // --- storage helpers -------------------------------------------------------
  // Synchronous SQL rather than the async KV API: this is the hot path and the
  // whole invocation has a 10ms CPU budget.

  #get(k: string): string | null {
    const row = this.#sql.exec("select v from kv where k = ?", k).toArray()[0];
    return row ? (row["v"] as string) : null;
  }

  #getNum(k: string): number | null {
    const v = this.#get(k);
    return v === null ? null : Number(v);
  }

  #set(k: string, v: string): void {
    this.#sql.exec(
      "insert into kv (k, v) values (?, ?) on conflict(k) do update set v = excluded.v",
      k,
      v,
    );
  }

  #del(k: string): void {
    this.#sql.exec("delete from kv where k = ?", k);
  }

  /**
   * Tells the DO who it is. Inbound sets this too, but the dashboard can act on a
   * conversation this instance has never seen an inbound for — after a rename of the
   * DO id, or simply a takeover as the first action of the day.
   */
  async attach(identity: {
    orgId: string;
    waAccountId: string;
    customerWaId: string;
    conversationId: string;
  }): Promise<void> {
    this.#set("org_id", identity.orgId);
    this.#set("wa_account_id", identity.waAccountId);
    this.#set("customer_wa_id", identity.customerWaId);
    this.#set("conversation_id", identity.conversationId);
  }

  /**
   * Erases one customer's data (DPDP §12). Owner-gated in the API route.
   *
   * A conversation that was flagged keeps its proof — safety.md: "delete the payload,
   * keep the proof." Its content is scrubbed but the rows, wa_message_ids, timestamps,
   * safety_flags and the conversation row survive, because safety_flags FK-cascades on
   * conversation delete. Everything else is deleted outright.
   */
  async erase(): Promise<void> {
    const orgId = this.#get("org_id");
    const conversationId = this.#get("conversation_id");
    if (!orgId || !conversationId) throw new Error("erase called before attach");

    const db = createOrgDb(this.env, orgId);

    // Full list, not OrgDb's 20-row cap: inbound_dedupe is keyed by wa_message_id, so
    // every id must be read before its rows go. Org-filtered in code, like every
    // createServiceClient call.
    const { data: rows, error: idsError } = await createServiceClient(this.env)
      .from("messages")
      .select("wa_message_id")
      .eq("org_id", orgId)
      .eq("conversation_id", conversationId);
    if (idsError) throw new Error(`message id lookup failed: ${idsError.message}`);
    const waIds = (rows ?? []).map((row) => row.wa_message_id as string);

    const flagged = await db.select("safety_flags", "id").eq("conversation_id", conversationId);
    if (flagged.error) throw new Error(`safety_flags lookup failed: ${flagged.error.message}`);
    const hasFlags = (flagged.data?.length ?? 0) > 0;

    const usage = await db.delete("usage_events").eq("conversation_id", conversationId);
    if (usage.error) throw new Error(`usage_events erase failed: ${usage.error.message}`);

    if (waIds.length > 0) {
      const dedupe = await db.delete("inbound_dedupe").in("wa_message_id", waIds);
      if (dedupe.error) throw new Error(`inbound_dedupe erase failed: ${dedupe.error.message}`);
    }

    if (hasFlags) {
      const scrub = await db
        .update("messages", { body: null, media_r2_key: null })
        .eq("conversation_id", conversationId);
      if (scrub.error) throw new Error(`flagged content erase failed: ${scrub.error.message}`);
    } else {
      const messages = await db.delete("messages").eq("conversation_id", conversationId);
      if (messages.error) throw new Error(`messages erase failed: ${messages.error.message}`);
      const conversation = await db.delete("conversations").eq("id", conversationId);
      if (conversation.error) throw new Error(`conversation erase failed: ${conversation.error.message}`);
    }

    // Media dies in both branches. A scrubbed flagged conversation keeps the proof
    // that we responded correctly, and an image is never part of that proof.
    await this.#eraseMedia(orgId, conversationId);

    // Drop the DO's own copy so a re-message from the same customer starts clean.
    this.#sql.exec("delete from seen");
    this.#sql.exec("delete from pending");
    this.#sql.exec("delete from kv");
  }

  /** Deletes every R2 object under one conversation's prefix, 1000 keys at a time. */
  async #eraseMedia(orgId: string, conversationId: string): Promise<void> {
    const prefix = `media/${orgId}/${conversationId}/`;
    let cursor: string | undefined;
    do {
      const listed = await this.env.MEDIA.list(cursor ? { prefix, cursor } : { prefix });
      if (listed.objects.length > 0) {
        await this.env.MEDIA.delete(listed.objects.map((object) => object.key));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  // --- inbound ---------------------------------------------------------------

  async onInbound(msg: InboundMessage): Promise<"accepted" | "duplicate"> {
    // The DO is the source of truth for dedupe. A repeat never reaches Postgres.
    if (this.#sql.exec("select 1 from seen where wa_message_id = ?", msg.waMessageId).toArray().length > 0) {
      return "duplicate";
    }

    this.#sql.exec(
      "insert into seen (wa_message_id, seen_at) values (?, ?)",
      msg.waMessageId,
      Date.now(),
    );
    this.#sql.exec("delete from seen where id <= (select max(id) from seen) - ?", SEEN_LIMIT);

    this.#set("org_id", msg.orgId);
    this.#set("wa_account_id", msg.waAccountId);
    this.#set("customer_wa_id", msg.customerWaId);

    // A new customer message closes out a finished handoff.
    if (this.#handoff() === "returned") this.#set("handoff", "bot");

    this.#sql.exec(
      "insert or replace into pending (wa_message_id, type, body, sent_at) values (?, ?, ?, ?)",
      msg.waMessageId,
      msg.type,
      msg.body,
      msg.sentAt,
    );

    await this.#persistInbound(msg);
    await this.#scheduleDebounce();
    return "accepted";
  }

  async #persistInbound(msg: InboundMessage): Promise<void> {
    const db = createOrgDb(this.env, msg.orgId);
    const conversationId = await this.#conversationId(db, msg);

    const { error } = await db.insert("messages", {
      conversation_id: conversationId,
      wa_message_id: msg.waMessageId,
      direction: "inbound",
      type: msg.type,
      body: msg.body,
      media_r2_key: await this.#storeMedia(msg, conversationId),
      created_at: new Date(msg.sentAt).toISOString(),
    });
    if (error) throw new Error(`message insert failed: ${error.message}`);

    // Second line of defence, for when this DO is evicted and loses its `seen` table.
    const dedupe = await db.insert("inbound_dedupe", { wa_message_id: msg.waMessageId });
    if (dedupe.error) throw new Error(`inbound_dedupe insert failed: ${dedupe.error.message}`);
  }

  /**
   * Copies media to R2 and returns its key, or null. Streamed straight from Meta to
   * R2, so the bytes never land in memory and cost I/O rather than CPU.
   *
   * Media failing must never cost us the message: the customer's text and the dedupe
   * record matter more than the attachment, and this message id is already in `seen`,
   * so a throw here would drop the turn entirely on retry.
   */
  async #storeMedia(msg: InboundMessage, conversationId: string): Promise<string | null> {
    if (!msg.mediaId) return null;

    try {
      const target = await this.#sendTarget();
      if (!target) return null;

      const media = await downloadMedia(this.env, target.send, msg.mediaId);
      if (!media) return null;

      // org and conversation lead the key so erasure can drop a customer's media with
      // one prefix list, and so no two orgs can ever collide.
      const key = `media/${msg.orgId}/${conversationId}/${msg.waMessageId}`;
      await this.env.MEDIA.put(key, media.body, {
        httpMetadata: { contentType: media.contentType },
      });
      return key;
    } catch {
      return null;
    }
  }

  async #conversationId(db: OrgDb, msg: InboundMessage): Promise<string> {
    const expires = windowExpiresAt(new Date(msg.sentAt)).toISOString();
    const lastAt = new Date(msg.sentAt).toISOString();

    const cached = this.#get("conversation_id");
    if (cached) {
      const { error } = await db
        .update("conversations", { window_expires_at: expires, last_message_at: lastAt })
        .eq("id", cached);
      if (error) throw new Error(`conversation update failed: ${error.message}`);
      return cached;
    }

    const { data, error } = await db
      .upsert(
        "conversations",
        {
          wa_account_id: msg.waAccountId,
          customer_wa_id: msg.customerWaId,
          window_expires_at: expires,
          last_message_at: lastAt,
        },
        { onConflict: "org_id,wa_account_id,customer_wa_id" },
      )
      .select("id")
      .single<{ id: string }>();

    if (error || !data) throw new Error(`conversation upsert failed: ${error?.message}`);
    this.#set("conversation_id", data.id);
    return data.id;
  }

  // --- debounce --------------------------------------------------------------

  async #scheduleDebounce(): Promise<void> {
    // A batch already forming keeps its original deadline, so a customer typing in
    // bursts cannot push the reply out indefinitely.
    if (this.#getNum("debounce_at") !== null) return;
    this.#set("debounce_at", String(Date.now() + DEBOUNCE_MS));
    await this.#reschedule();
  }

  /**
   * One alarm slot, two deadlines. Whichever is sooner wins and the other is
   * re-armed after it fires.
   */
  async #reschedule(): Promise<void> {
    const deadlines = [this.#getNum("debounce_at"), this.#getNum("handoff_return_at")].filter(
      (t): t is number => t !== null,
    );

    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const next = Math.min(...deadlines);
    if ((await this.ctx.storage.getAlarm()) !== next) await this.ctx.storage.setAlarm(next);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();

    const debounceAt = this.#getNum("debounce_at");
    if (debounceAt !== null && debounceAt <= now) {
      this.#del("debounce_at");
      await this.#flushBatch();
    }

    const returnAt = this.#getNum("handoff_return_at");
    if (returnAt !== null && returnAt <= now) {
      this.#del("handoff_return_at");
      await this.#autoReturn();
    }

    await this.#reschedule();
  }

  async #flushBatch(): Promise<void> {
    const batch = this.#sql
      .exec("select wa_message_id, type, body, sent_at from pending order by sent_at")
      .toArray();
    this.#sql.exec("delete from pending");

    if (batch.length === 0) return;
    this.#set("last_batch_size", String(batch.length));

    // A human holding the conversation reads the inbox; the bot stays quiet.
    if (!this.#canBotReply()) return;

    // The whole burst is answered once, and the claim is against its last id: that is
    // the id a Meta retry of the same burst would carry.
    const customerText = batch
      .map((row) => row["body"] as string | null)
      .filter((body): body is string => Boolean(body))
      .join("\n");
    const anchor = batch[batch.length - 1]!["wa_message_id"] as string;

    // Meta rejects free-form messages outside the 24h window, and every inbound resets
    // it, so this only fires on stale processing — a burst answered long after it was
    // sent. A template is the only thing that may legally go out (the #1 "why no
    // reply?"), and it cannot carry the reply, so the handoff stands either way.
    const last = batch[batch.length - 1]!;
    if (!isWindowOpen(new Date(), windowExpiresAt(new Date(last["sent_at"] as number)))) {
      await this.#reengage(anchor, customerText);
      return;
    }

    await this.#reply(anchor, customerText);
  }

  // --- reply path ------------------------------------------------------------

  async #reply(anchor: string, customerText: string): Promise<void> {
    // The regex prefilter runs before the model and outranks it. A flagged turn never
    // reaches the LLM at all, so there is no model text to leak.
    const prefiltered = prefilter(customerText);
    if (prefiltered) {
      await this.#sendSafe(anchor, prefiltered);
      return;
    }

    const context = await this.#promptContext();
    if (!context) return;

    let completion;
    try {
      completion = await complete(
        this.env,
        buildMessages({
          businessName: context.businessName,
          sector: context.sector,
          kb: context.kb,
          history: context.history,
          customerText,
        }),
      );
    } catch {
      // Two timeouts. Never leave the customer with silence.
      await this.#send(anchor, FALLBACK_REPLY);
      await this.requestHandoff();
      return;
    }

    const flagged = flagFromModel(completion.flags);
    if (flagged) {
      await this.#sendSafe(anchor, flagged);
      return;
    }

    let reply: string;
    try {
      reply = assertSingleReply(completion.reply);
    } catch {
      await this.#sendBlocked(anchor);
      return;
    }

    // The client's KB can contradict every instruction in the prompt, so the sector
    // rules are checked here, on the finished text.
    if (!checkOutput(context.sector, reply).ok) {
      await this.#sendBlocked(anchor);
      return;
    }

    // Billed only when the reply actually went out: a replayed burst where the claim
    // is already set sends nothing, and must not bill twice.
    const sent = await this.#send(anchor, reply);
    if (sent) await this.#recordUsage(completion.usage);
  }

  /** A flagged turn gets the constant string, a safety_flags row, and a human. */
  async #sendSafe(anchor: string, kind: SafetyKind): Promise<void> {
    await this.#send(anchor, SAFE_REPLY[kind]);
    await this.#recordFlag(kind);
    // Invariant 11: a minor stops the AI with no auto-resume, which is exactly what
    // the handoff lock already does.
    await this.requestHandoff();
  }

  async #sendBlocked(anchor: string): Promise<void> {
    await this.#send(anchor, BLOCKED_REPLY);
    await this.requestHandoff();
  }

  /**
   * The 24h window is shut, so the model's answer can never be delivered. A template
   * is the only legal send, and its text was fixed at approval time, so all it can do
   * is invite the customer to write back — which re-opens the window.
   *
   * The handoff happens either way: a person still owes this customer a reply, and an
   * unconfigured template must not turn into silence.
   */
  async #reengage(anchor: string, customerText: string): Promise<void> {
    await this.requestHandoff();

    // safety.md: never send engagement content toward a flagged conversation. The
    // prefilter is the only detector available here — a flagged turn never reaches the
    // model, and outside the window there is no model call at all.
    const flagged = prefilter(customerText);
    if (flagged) {
      await this.#recordFlag(flagged);
      return;
    }

    // Claimed like any other send: a replayed stale burst must not template twice.
    if (!(await this.claimReply(anchor))) return;

    const target = await this.#sendTarget();
    if (!target?.template) return;

    const waMessageId = await sendTemplate(
      this.env,
      target.send,
      target.customerWaId,
      target.template,
    );

    const orgId = this.#get("org_id");
    const conversationId = this.#get("conversation_id");
    if (!orgId || !conversationId) return;

    const { error } = await createOrgDb(this.env, orgId).insert("messages", {
      conversation_id: conversationId,
      wa_message_id: waMessageId,
      direction: "outbound",
      type: "template",
      body: `[template: ${target.template.name}]`,
    });
    if (error) throw new Error(`template insert failed: ${error.message}`);
  }

  /**
   * The only place that talks to Meta. Invariant 4: the claim is written first, so a
   * retry of this whole path sends nothing rather than sending twice.
   */
  async #send(anchor: string, body: string): Promise<boolean> {
    if (!(await this.claimReply(anchor))) return false;
    return this.#deliver(body);
  }

  /**
   * A message typed by a human in the dashboard. No claim: the claim exists to stop
   * the *bot* answering the same inbound twice, and a person pressing send twice meant
   * to send twice. Pushes the idle timer out so the auto-return does not fire mid-reply.
   */
  async sendHuman(body: string): Promise<"sent" | "not_human"> {
    // A result rather than a throw: the caller is across an RPC boundary, and "someone
    // else holds this conversation" is an outcome, not a failure.
    if (this.#handoff() !== "human") return "not_human";
    await this.#deliver(body);
    await this.touchHuman();
    return "sent";
  }

  async #deliver(body: string): Promise<boolean> {
    const target = await this.#sendTarget();
    if (!target) return false;

    const waMessageId = await sendText(this.env, target.send, target.customerWaId, body);

    const orgId = this.#get("org_id");
    const conversationId = this.#get("conversation_id");
    if (!orgId || !conversationId) return false;

    const { error } = await createOrgDb(this.env, orgId).insert("messages", {
      conversation_id: conversationId,
      wa_message_id: waMessageId,
      direction: "outbound",
      type: "text",
      body,
    });
    // Recoverable on purpose: a sent message with no row can be reconciled from Meta,
    // a second send to the customer cannot be taken back.
    if (error) throw new Error(`outbound insert failed: ${error.message}`);
    return true;
  }

  /** The model spend behind one reply. Runs only after the send, so billing never
   *  holds up the customer, and only for LLM replies — the constant safety strings
   *  and human sends cost nothing. */
  async #recordUsage(usage: Completion["usage"]): Promise<void> {
    const orgId = this.#get("org_id");
    const conversationId = this.#get("conversation_id");
    if (!orgId || !conversationId) return;

    const { error } = await createOrgDb(this.env, orgId).insert("usage_events", {
      conversation_id: conversationId,
      pricing_category: "reply",
      cost_micros: costMicros(usage),
    });
    if (error) throw new Error(`usage_events insert failed: ${error.message}`);
  }

  async #recordFlag(kind: SafetyKind): Promise<void> {
    const orgId = this.#get("org_id");
    const conversationId = this.#get("conversation_id");
    if (!orgId || !conversationId) return;

    const { error } = await createOrgDb(this.env, orgId).insert("safety_flags", {
      conversation_id: conversationId,
      kind,
    });
    if (error) throw new Error(`safety_flags insert failed: ${error.message}`);
  }

  async #promptContext(): Promise<{
    businessName: string;
    sector: Sector;
    kb: string;
    history: PromptTurn[];
  } | null> {
    const orgId = this.#get("org_id");
    const conversationId = this.#get("conversation_id");
    if (!orgId || !conversationId) return null;

    const db = createOrgDb(this.env, orgId);

    const { data: orgRow } = await db
      .organization("name,sector")
      .maybeSingle<{ name: string; sector: Sector }>();

    const { data: docs } = await db
      .select("kb_documents", "raw", { limit: 5 })
      .returns<Array<{ raw: string }>>();
    const { data: history } = await db
      .select("messages", "direction,body", { limit: HISTORY_LIMIT })
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .returns<PromptTurn[]>();

    return {
      businessName: orgRow?.name ?? "the business",
      sector: orgRow?.sector ?? "general",
      kb: (docs ?? []).map((d) => d.raw).join("\n\n"),
      // Oldest first for the model; the query is newest first so the limit takes the
      // recent end.
      history: (history ?? []).slice().reverse(),
    };
  }

  async #sendTarget(): Promise<{
    send: SendTarget;
    customerWaId: string;
    template: { name: string; language: string } | null;
  } | null> {
    const orgId = this.#get("org_id");
    const waAccountId = this.#get("wa_account_id");
    const customerWaId = this.#get("customer_wa_id");
    if (!orgId || !waAccountId || !customerWaId) return null;

    const { data, error } = await createOrgDb(this.env, orgId)
      .select(
        "wa_accounts",
        "phone_number_id,token_ciphertext,token_iv,token_key_version," +
          "reengagement_template_name,reengagement_template_lang",
        { limit: 1 },
      )
      .eq("id", waAccountId)
      .maybeSingle<{
        phone_number_id: string;
        token_ciphertext: string;
        token_iv: string;
        token_key_version: number;
        reengagement_template_name: string | null;
        reengagement_template_lang: string | null;
      }>();

    if (error) throw new Error(`wa_account lookup failed: ${error.message}`);
    if (!data) return null;

    const name = data.reengagement_template_name;
    const language = data.reengagement_template_lang;

    return {
      send: {
        phoneNumberId: data.phone_number_id,
        tokenCiphertext: data.token_ciphertext,
        tokenIv: data.token_iv,
        tokenKeyVersion: data.token_key_version,
      },
      customerWaId,
      template: name && language ? { name, language } : null,
    };
  }

  // --- handoff ---------------------------------------------------------------

  #handoff(): HandoffState {
    return (this.#get("handoff") as HandoffState | null) ?? "bot";
  }

  #canBotReply(): boolean {
    const state = this.#handoff();
    return state === "bot" || state === "returned";
  }

  async getState(): Promise<{
    handoff: HandoffState;
    canBotReply: boolean;
    pending: number;
    lastBatchSize: number | null;
  }> {
    const pending = this.#sql.exec("select count(*) as n from pending").toArray()[0];
    return {
      handoff: this.#handoff(),
      canBotReply: this.#canBotReply(),
      pending: Number(pending?.["n"] ?? 0),
      lastBatchSize: this.#getNum("last_batch_size"),
    };
  }

  async requestHandoff(): Promise<void> {
    if (this.#handoff() === "human") return;
    this.#set("handoff", "requested");
    await this.#syncHandoff("requested");
  }

  async takeOver(): Promise<void> {
    this.#set("handoff", "human");
    this.#set("handoff_return_at", String(Date.now() + HANDOFF_IDLE_MS));
    await this.#reschedule();
    await this.#syncHandoff("human");
  }

  /** Any human activity pushes the idle timer out. */
  async touchHuman(): Promise<void> {
    if (this.#handoff() !== "human") return;
    this.#set("handoff_return_at", String(Date.now() + HANDOFF_IDLE_MS));
    await this.#reschedule();
  }

  async release(): Promise<void> {
    this.#del("handoff_return_at");
    this.#set("handoff", "returned");
    await this.#reschedule();
    await this.#syncHandoff("returned");
  }

  async #autoReturn(): Promise<void> {
    if (this.#handoff() !== "human") return;
    this.#set("handoff", "returned");
    await this.#syncHandoff("returned");
  }

  async #syncHandoff(state: HandoffState): Promise<void> {
    const orgId = this.#get("org_id");
    const conversationId = this.#get("conversation_id");
    if (!orgId || !conversationId) return;

    const { error } = await createOrgDb(this.env, orgId)
      .update("conversations", { handoff_state: state })
      .eq("id", conversationId);
    if (error) throw new Error(`handoff sync failed: ${error.message}`);
  }

  // --- outbound idempotency --------------------------------------------------

  /**
   * Invariant 4. Call this immediately *before* the Meta send, never after.
   * A successful Meta call with no Postgres row is recoverable; a second Meta call
   * to the same customer is not.
   */
  async claimReply(inboundWaMessageId: string): Promise<boolean> {
    const seen = this.#sql
      .exec("select 1 from replies where inbound_wa_message_id = ?", inboundWaMessageId)
      .toArray();
    if (seen.length > 0) return false;

    this.#sql.exec(
      "insert into replies (inbound_wa_message_id, claimed_at) values (?, ?)",
      inboundWaMessageId,
      Date.now(),
    );
    return true;
  }
}
