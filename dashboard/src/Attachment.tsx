import { useEffect, useState } from "react";
import { supabase, type Message } from "./lib/supabase";

/**
 * Matches MEDIA_BUCKET in packages/shared. Duplicated rather than imported: the shared
 * package is the Worker's, and pulling it in for one string would put it in the bundle.
 */
const MEDIA_BUCKET = "media";

/** Long enough to open a thread and scroll it, short enough that a copied link dies. */
const SIGNED_URL_TTL_S = 600;

/**
 * Signed URLs for every attachment on screen, keyed by storage path.
 *
 * The bucket is private, so each image needs its own URL. Signed in one batch rather
 * than per bubble: a request per thumbnail would spend the request budget on a screen
 * that is already paying egress for the bytes.
 */
export function useSignedUrls(messages: Message[]): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());

  const missing = [
    ...new Set(
      messages
        .map((m) => m.media_key)
        .filter((key): key is string => Boolean(key) && !urls.has(key as string)),
    ),
  ];
  // Effects compare deps by identity, and a fresh array every render would loop.
  const wanted = missing.join("\n");

  useEffect(() => {
    if (missing.length === 0) return;
    let cancelled = false;

    void (async () => {
      const { data } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrls(missing, SIGNED_URL_TTL_S);
      if (cancelled || !data) return;

      setUrls((prev) => {
        const next = new Map(prev);
        // A path the policy denies comes back with an error and no URL. Skipping it
        // leaves the bubble on its "no longer stored" branch rather than a broken image.
        for (const row of data) {
          if (row.path && row.signedUrl) next.set(row.path, row.signedUrl);
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  return urls;
}

/** Why the bytes are not here. Null media_key on an attachment is normal, not an error. */
function missingLabel(type: string): string {
  if (type === "video") return "Video — not saved. The customer was asked to send a photo.";
  return "Attachment is no longer stored.";
}

export default function Attachment({
  message,
  url,
}: {
  message: Message;
  url: string | undefined;
}) {
  const { type, media_key } = message;

  if (!media_key) {
    return <div className="text-xs italic opacity-70">{missingLabel(type)}</div>;
  }

  if (!url) {
    return <div className="text-xs italic opacity-70">Loading attachment…</div>;
  }

  if (type === "image" || type === "sticker") {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        {/* Lazy so a thread of photos does not download every one on open — the 5GB
            egress budget is shared with every other read the dashboard makes. */}
        <img
          src={url}
          loading="lazy"
          alt={message.body ?? "Attachment"}
          className="max-h-64 rounded"
        />
      </a>
    );
  }

  if (type === "audio") {
    // preload=none for the same reason images are lazy: a voice note costs egress only
    // when someone actually plays it.
    return <audio controls preload="none" src={url} className="max-w-full" />;
  }

  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-xs underline">
      Open {type}
    </a>
  );
}
