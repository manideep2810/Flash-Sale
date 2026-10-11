import { createHash } from "node:crypto";

// Cover images are uploaded by the admin's browser straight to Cloudinary, never through this
// service. What the browser needs for that is a signature made with the account's API secret, which
// stays here: the browser gets a signature that is good for one upload shape (this folder, these
// formats) for about an hour, and never the secret.

export interface UploadConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Where in the account the covers go. */
  folder: string;
}

/** Everything the browser posts to `uploadUrl` beside the file itself, each field under its own name. */
export interface UploadTicket {
  uploadUrl: string;
  fields: {
    api_key: string;
    timestamp: string;
    folder: string;
    allowed_formats: string;
    signature: string;
  };
}

export interface UploadSigner {
  sign(now?: number): UploadTicket;
}

/** Cloudinary refuses a file of any other format when this is among the signed parameters. */
const ALLOWED_FORMATS = "jpg,png,webp,avif";

/**
 * Cloudinary's signature: the parameters being signed, sorted by name and joined as a query string,
 * with the API secret appended, hashed with SHA-1 (the account default), in hex. `file`, `api_key`
 * and `cloud_name` are never part of it.
 */
export function signParams(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");
  return createHash("sha1")
    .update(toSign + apiSecret)
    .digest("hex");
}

export function createUploadSigner({
  cloudName,
  apiKey,
  apiSecret,
  folder,
}: UploadConfig): UploadSigner {
  const uploadUrl = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`;
  return {
    sign(now = Date.now()) {
      const signed = {
        allowed_formats: ALLOWED_FORMATS,
        folder,
        // Seconds. Cloudinary accepts a signature for an hour from this instant.
        timestamp: String(Math.floor(now / 1000)),
      };
      return {
        uploadUrl,
        fields: { api_key: apiKey, ...signed, signature: signParams(signed, apiSecret) },
      };
    },
  };
}
