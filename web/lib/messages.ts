// One human sentence for every error code the backend or the gateway can answer with, and for every
// order state. The screen shows these and nothing else: never the server's own text or raw JSON.

const ERRORS: Record<string, string> = {
  // The gateway and the session check
  UNAUTHENTICATED: "You are not logged in. Log in to continue.",
  SESSION_EXPIRED: "Your session ended. Log in again.",
  RATE_LIMITED: "You are going too fast. Wait a moment and try again.",
  // Logging in
  INVALID_CREDENTIALS: "That password is not right.",
  ADMIN_LOGIN_OFF: "The admin login is switched off on this server.",
  FORBIDDEN: "This needs an admin login.",
  // The catalogue
  EVENT_NOT_FOUND: "There is no such event.",
  CATALOGUE_UNAVAILABLE: "The events could not be loaded just now. Try again in a moment.",
  EVENT_EXISTS: "An event with that id already exists. Choose another id.",
  SYNC_FAILED: "Saved, but the live sale could not be updated. Save again in a moment.",
  UPLOADS_NOT_CONFIGURED:
    "Image uploads are not set up on this server. Paste an image URL instead.",
  UPLOAD_BAD_TYPE: "That file is not an image we can use. Choose a JPEG, PNG, WebP or AVIF.",
  UPLOAD_TOO_LARGE: "That image is too large. Choose one under 5 MB.",
  UPLOAD_FAILED: "The image could not be uploaded. Try again.",
  // The waiting room
  NOT_OPEN: "The lobby is not open yet.",
  QUEUE_UNAVAILABLE: "The waiting room is temporarily unavailable. Keep this page open.",
  // Reserving
  SOLD_OUT: "Sold out.",
  ADMISSION_REQUIRED: "It is not your turn yet.",
  TOKEN_EXPIRED: "Your turn expired.",
  TOKEN_INVALID: "Your place in line could not be confirmed. Go back to the queue.",
  TOKEN_MISMATCH: "This turn belongs to a different user or event. Go back to the queue.",
  // Paying
  HOLD_EXPIRED: "Your hold expired.",
  NOT_PAYABLE: "This order can no longer be paid.",
  PRICE_UNAVAILABLE: "The payment could not be started just now. Nothing was charged: try again.",
  // Anything
  BAD_REQUEST: "That request was not valid.",
  NOT_FOUND: "That could not be found.",
  INTERNAL: "Something went wrong on our side. Try again.",
  NETWORK: "The server could not be reached. Check your connection and try again.",
  // The page was loaded from the web app's own port (3012 in development), which serves pages only.
  NOT_BEHIND_GATEWAY:
    "There is no API at this address. Open the app through the gateway instead: http://localhost:8080",
};

/** The sentence for an error code. An unknown code gets a generic one, by its HTTP status. */
export function sentenceFor(code: string, status = 0): string {
  return (
    ERRORS[code] ??
    (status >= 500
      ? "Something went wrong on our side. Try again."
      : "That did not work. Try again.")
  );
}

export const WAITING_ROOM_UNAVAILABLE =
  "The waiting room is temporarily unavailable. Keep this page open.";

/**
 * Where the checkout page notes that it watched a payment fail, for the result page. sessionStorage,
 * like the session: it is a display hint about an order, not a credential.
 */
export const paymentFailedKey = (orderId: string) => `flash.paymentFailed.${orderId}`;

/** The one sentence the result page shows for an order. `sawPaymentFail` is this browser's memory. */
export function sentenceForOrder(state: string, sawPaymentFail: boolean): string {
  switch (state) {
    case "PAID":
    case "CONFIRMED":
      return "Order confirmed";
    case "PAYMENT_FAILED":
      return "Payment failed — your item was released";
    case "EXPIRED":
      return "Your hold expired";
    case "RELEASED":
      // The order does not say why it was released: a failed payment and an expired hold end here alike.
      return sawPaymentFail ? "Payment failed — your item was released" : "Your hold was released";
    case "HELD":
      return "Your item is on hold and waiting for payment";
    case "PAYMENT_PENDING":
      return "Your payment is being processed";
    case "REFUNDED":
      return "This order was refunded";
    default:
      return "This order is in an unknown state";
  }
}
