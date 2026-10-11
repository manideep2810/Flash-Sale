"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AdminGate } from "@/components/admin/AdminGate";
import { EventForm } from "@/components/admin/EventForm";
import { ArrowLeftIcon } from "@/components/Icons";
import { type AdminEvent, adminListEvents, toFailure } from "@/lib/api";
import { segment } from "@/lib/format";

/** Edit one event: everything but its id and its stock. */
function EditEvent() {
  const eventId = segment(useParams().id);
  const [event, setEvent] = useState<AdminEvent | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    adminListEvents().then(
      ({ events }) => {
        if (!current) {
          return;
        }
        const found = events.find((candidate) => candidate.id === eventId);
        if (found) {
          setEvent(found);
        } else {
          setProblem("There is no such event.");
        }
      },
      (error) => {
        const failure = toFailure(error);
        if (current && !failure.unauthenticated) {
          setProblem(failure.message);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [eventId]);

  return (
    <section className="admin admin--form">
      <Link className="back-link" href="/admin">
        <ArrowLeftIcon size={16} /> Dashboard
      </Link>
      <p className="eyebrow">Admin</p>
      <h1>{event ? `Edit ${event.name}` : "Edit event"}</h1>
      {problem ? (
        <p className="alert" role="alert">
          {problem}
        </p>
      ) : null}
      {!event && !problem ? <p className="muted">Loading…</p> : null}
      {event ? <EventForm event={event} /> : null}
    </section>
  );
}

export default function EditEventPage() {
  return (
    <AdminGate>
      <EditEvent />
    </AdminGate>
  );
}
