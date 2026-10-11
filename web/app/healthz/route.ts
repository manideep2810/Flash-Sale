// What the gateway's health check asks: is the web server up. It calls no API and reads no data.
export function GET() {
  return Response.json({ ok: true });
}
