"use client";

import { type CSSProperties, useState } from "react";

interface EventCoverProps {
  event: { id: string; name: string; imageUrl: string | null };
  className?: string;
  /** For the one cover at the top of a page: load it at once, not when it scrolls into view. */
  eager?: boolean;
}

/** A hue for an event, the same one every time: from its id. */
function hueOf(id: string): number {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

/** "Aurora Sound Festival" -> "AS". */
function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

/**
 * An event's cover: its image, or, when it has none or the image does not load, a poster made from
 * its name in a colour of its own. The image is whatever https URL the admin gave (Cloudinary when
 * uploaded from the admin page), so it is a plain <img>: there is no list of hosts to optimise from.
 */
export function EventCover({ event, className = "", eager = false }: EventCoverProps) {
  // The URL that failed to load, so that a new one (the admin replaced the cover) gets a fresh try.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const url = event.imageUrl && event.imageUrl !== brokenUrl ? event.imageUrl : null;

  return (
    <div
      className={`cover ${className}`}
      style={{ "--cover-hue": String(hueOf(event.id)) } as CSSProperties}
    >
      {url ? (
        <img
          className="cover__image"
          src={url}
          alt=""
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onError={() => setBrokenUrl(url)}
        />
      ) : (
        <span className="cover__poster" aria-hidden="true">
          {initialsOf(event.name)}
        </span>
      )}
    </div>
  );
}
