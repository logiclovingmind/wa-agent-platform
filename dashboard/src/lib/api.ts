import { supabase } from "./supabase";

/**
 * The writes that need the Worker. Everything else the dashboard does is a read
 * straight from Supabase under RLS — see supabase.ts.
 */
const BASE = import.meta.env.VITE_API_URL;

async function post(path: string, body?: unknown): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("signed out");

  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export async function takeover(conversationId: string): Promise<void> {
  const res = await post(`/api/conversations/${conversationId}/takeover`);
  if (!res.ok) throw new Error(await res.text());
}

export async function release(conversationId: string): Promise<void> {
  const res = await post(`/api/conversations/${conversationId}/release`);
  if (!res.ok) throw new Error(await res.text());
}

export async function reply(conversationId: string, body: string): Promise<void> {
  const res = await post(`/api/conversations/${conversationId}/reply`, { body });
  // 409 means the bot still owns the conversation: take over first.
  if (!res.ok) throw new Error(await res.text());
}

/** DPDP erasure. Irreversible, owner-only, and audited on the Worker side. */
export async function erase(conversationId: string): Promise<void> {
  const res = await post(`/api/conversations/${conversationId}/erase`);
  if (!res.ok) throw new Error(await res.text());
}

/**
 * The whole conversation, past the 20-row page the thread reads: this is the DPDP
 * access right, and a partial answer to it is not an answer. Media comes back as keys
 * rather than bytes, so an export cannot pull the egress budget through the Worker.
 */
export async function exportConversation(conversationId: string): Promise<unknown> {
  const res = await post(`/api/conversations/${conversationId}/export`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
