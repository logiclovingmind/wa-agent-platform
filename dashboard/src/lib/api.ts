import { supabase } from "./supabase";

/**
 * The three writes that need the Worker. Everything else the dashboard does is a read
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
