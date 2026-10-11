"use client";

import Link from "next/link";
import { AdminGate } from "@/components/admin/AdminGate";
import { EventForm } from "@/components/admin/EventForm";
import { ArrowLeftIcon } from "@/components/Icons";

/** A new event. Saving it puts it on the front page, with its stock and its waiting room ready. */
export default function NewEventPage() {
  return (
    <AdminGate>
      <section className="admin admin--form">
        <Link className="back-link" href="/admin">
          <ArrowLeftIcon size={16} /> Dashboard
        </Link>
        <p className="eyebrow">Admin</p>
        <h1>New event</h1>
        <EventForm event={null} />
      </section>
    </AdminGate>
  );
}
