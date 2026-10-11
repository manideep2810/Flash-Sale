"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

/** The front door: name an event and go to its page. `demo` is what the seed script creates. */
export default function HomePage() {
  const router = useRouter();
  const [eventId, setEventId] = useState("demo");

  function open(event: FormEvent) {
    event.preventDefault();
    if (eventId.trim()) {
      router.push(`/events/${encodeURIComponent(eventId.trim())}`);
    }
  }

  return (
    <>
      <h1>Flash sale</h1>
      <form onSubmit={open}>
        <label>
          Event id <input value={eventId} onChange={(event) => setEventId(event.target.value)} />
        </label>{" "}
        <button type="submit">Open event</button>
      </form>
    </>
  );
}
