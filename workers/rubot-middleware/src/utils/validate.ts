/**
 * Shared input validation regexes for rubot-middleware route handlers.
 *
 * Hoisted out of individual route files so the provisioning + bind-session
 * paths agree on what a valid identifier looks like — the sender_id that
 * /api/provision/consume writes into identity_bindings must satisfy the
 * same shape /api/internal/bind-session is willing to look up.
 */

// tenant_id — single segment, URL-safe, max 64 chars.
export const TENANT_ID_RX = /^[A-Za-z0-9_\-.]{1,64}$/;

// session_id — opaque printable ASCII handle from the calling chat
// source (Telegram/WhatsApp/Slack/etc.), up to 256 chars.
export const SESSION_ID_RX = /^[\x20-\x7E]{1,256}$/;

// sender_id — generic chat-source sender handle. Allows the few special
// characters real-world IDs need (`+` for E.164 phone numbers, `:` for
// `wa:5511…` / `tg:123…` style namespacing).
export const SENDER_ID_RX = /^[A-Za-z0-9_\-.:+]{1,128}$/;
