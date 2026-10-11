"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { AdminGate } from "@/components/admin/AdminGate";
import { StatusBadge } from "@/components/EventBits";
import { EventCover } from "@/components/EventCover";
import { PencilIcon, PlusIcon } from "@/components/Icons";
import {
  type AdminEvent,
  type ApiFailure,
  adminListEvents,
  adminOrderMetrics,
  type OrderMetricsRow,
} from "@/lib/api";
import { statusNow, useServerNow } from "@/lib/events";
import { formatCount, formatDateTime, formatPrice } from "@/lib/format";
import { usePolling } from "@/lib/usePolling";

/** The dashboard reads everything again this often. */
const REFRESH_MS = 5_000;

interface Snapshot {
  /** False when the stock and queue numbers (from Redis) could not be read. */
  live: boolean;
  events: AdminEvent[];
  orders: OrderMetricsRow[];
}

/** Order states, in the order an order passes through them, with what the page calls them. */
const ORDER_STATES: [state: string, label: string][] = [
  ["HELD", "On hold"],
  ["PAYMENT_PENDING", "Payment pending"],
  ["PAID", "Paid"],
  ["CONFIRMED", "Confirmed"],
  ["PAYMENT_FAILED", "Payment failed"],
  ["EXPIRED", "Expired"],
  ["RELEASED", "Released"],
  ["REFUNDED", "Refunded"],
];

/** States in which the money has been taken. */
const PAID_STATES = new Set(["PAID", "CONFIRMED"]);

const sum = (values: (number | null)[]): number =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

/** One figure on the top row. */
function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <p className="tile__label">{label}</p>
      <p className="tile__value">{value}</p>
      {note ? <p className="tile__note">{note}</p> : null}
    </div>
  );
}

/**
 * Where an event's stock is: sold and in checkouts, as two segments of a bar whose empty part is
 * what is still available. The three numbers are written out under it, so the colours are never
 * the only way to read it.
 */
function StockBar({ event }: { event: AdminEvent }) {
  if (event.sold === null || event.held === null || event.available === null) {
    return <span className="muted">not available</span>;
  }
  const share = (value: number) => `${Math.min(100, (value / event.totalStock) * 100)}%`;
  const summary = `${formatCount(event.sold)} sold, ${formatCount(event.held)} in checkout, ${formatCount(event.available)} available, of ${formatCount(event.totalStock)}`;
  return (
    <div className="stockbar" title={summary}>
      <div className="stockbar__track" role="img" aria-label={summary}>
        {event.sold > 0 ? (
          <span
            className="stockbar__seg stockbar__seg--sold"
            style={{ width: share(event.sold) }}
          />
        ) : null}
        {event.held > 0 ? (
          <span
            className="stockbar__seg stockbar__seg--held"
            style={{ width: share(event.held) }}
          />
        ) : null}
      </div>
      <p className="stockbar__text">
        {formatCount(event.sold)} sold · {formatCount(event.held)} held ·{" "}
        {formatCount(event.available)} left
      </p>
    </div>
  );
}

function Dashboard() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const now = useServerNow();

  const fetcher = useCallback(async (): Promise<Snapshot> => {
    const [catalogue, orders] = await Promise.all([adminListEvents(), adminOrderMetrics()]);
    return { live: catalogue.live, events: catalogue.events, orders };
  }, []);
  const onResult = useCallback((loaded: Snapshot) => {
    setSnapshot(loaded);
    setProblem(null);
  }, []);
  const onError = useCallback((failure: ApiFailure) => {
    // A lost or non-admin session sends the page to the login by itself (AdminGate).
    if (!failure.unauthenticated) {
      setProblem(failure.message);
    }
  }, []);
  const { unavailable } = usePolling<Snapshot>({
    enabled: true,
    firstDelayMs: 0,
    fetcher,
    nextDelayMs: () => REFRESH_MS,
    onResult,
    onError,
  });

  const events = snapshot?.events ?? [];
  // The page is about the events in the catalogue. The Order table can also hold orders of events
  // that never had an entry (made before the catalogue existed, or by a test or a load run); those
  // are left out of every figure here and counted in a footnote.
  const listed = new Set(events.map((event) => event.id));
  const allOrders = snapshot?.orders ?? [];
  const orders = allOrders.filter((row) => listed.has(row.eventId));
  const unlistedOrders = sum(
    allOrders.filter((row) => !listed.has(row.eventId)).map((row) => row.orders),
  );
  const paid = orders.filter((row) => PAID_STATES.has(row.state));
  const revenue = sum(paid.map((row) => row.amount));
  const paidOrders = sum(paid.map((row) => row.orders));
  const byState = new Map<string, { orders: number; units: number }>();
  for (const row of orders) {
    const total = byState.get(row.state) ?? { orders: 0, units: 0 };
    byState.set(row.state, { orders: total.orders + row.orders, units: total.units + row.units });
  }
  const mostOrders = Math.max(1, ...[...byState.values()].map((total) => total.orders));
  const revenueOf = (eventId: string) =>
    sum(paid.filter((row) => row.eventId === eventId).map((row) => row.amount));
  const paidOrdersOf = (eventId: string) =>
    sum(paid.filter((row) => row.eventId === eventId).map((row) => row.orders));

  return (
    <section className="admin">
      <div className="section-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Sales dashboard</h1>
        </div>
        <Link className="btn btn--primary" href="/admin/events/new">
          <PlusIcon size={18} /> New event
        </Link>
      </div>

      {problem ? (
        <p className="alert" role="alert">
          {problem}
        </p>
      ) : null}
      {unavailable && !problem ? (
        <p className="alert" role="alert">
          The server cannot be reached. These numbers may be out of date.
        </p>
      ) : null}
      {snapshot && !snapshot.live ? (
        <p className="alert alert--warn" role="alert">
          The live stock and queue numbers cannot be read right now. Orders and revenue are current.
        </p>
      ) : null}

      <div className="tiles">
        <Tile
          label="Revenue"
          value={formatPrice(revenue)}
          note={`${formatCount(paidOrders)} paid ${paidOrders === 1 ? "order" : "orders"}`}
        />
        <Tile
          label="Tickets sold"
          value={formatCount(sum(events.map((event) => event.sold)))}
          note={`of ${formatCount(sum(events.map((event) => event.totalStock)))} on sale`}
        />
        <Tile
          label="In checkout"
          value={formatCount(sum(events.map((event) => event.held)))}
          note="tickets held, not yet paid"
        />
        <Tile
          label="In line now"
          value={formatCount(sum(events.map((event) => event.queued)))}
          note={`${formatCount(sum(events.map((event) => event.admitted)))} with a turn to buy`}
        />
      </div>

      <div className="admin__panel">
        <div className="admin__panel-head">
          <h2>Events</h2>
          <ul className="legend" aria-label="Stock bar legend">
            <li>
              <span className="legend__swatch legend__swatch--sold" /> Sold
            </li>
            <li>
              <span className="legend__swatch legend__swatch--held" /> In checkout
            </li>
            <li>
              <span className="legend__swatch legend__swatch--left" /> Available
            </li>
          </ul>
        </div>

        {snapshot === null && !problem ? <p className="muted">Loading…</p> : null}
        {snapshot !== null && events.length === 0 ? (
          <div className="empty">
            <p className="empty__title">No events yet</p>
            <p className="muted">Create the first one and it goes on the front page at once.</p>
          </div>
        ) : null}

        {events.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Status</th>
                  <th scope="col">Sale opens</th>
                  <th scope="col" className="num">
                    Price
                  </th>
                  <th scope="col">Stock</th>
                  <th scope="col" className="num">
                    In line
                  </th>
                  <th scope="col" className="num">
                    Revenue
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} data-testid={`admin-event-${event.id}`}>
                    <th scope="row">
                      <div className="table__event">
                        <EventCover event={event} className="cover--tiny" />
                        <div>
                          <Link href={`/events/${encodeURIComponent(event.id)}`}>{event.name}</Link>
                          <p className="table__id">{event.id}</p>
                        </div>
                      </div>
                    </th>
                    <td>
                      <StatusBadge status={statusNow(event, now)} />
                    </td>
                    <td>{formatDateTime(event.saleOpensAt)}</td>
                    <td className="num">{formatPrice(event.price)}</td>
                    <td>
                      <StockBar event={event} />
                    </td>
                    <td className="num">
                      {event.queued === null ? "—" : formatCount(event.queued)}
                    </td>
                    <td className="num">
                      {formatPrice(revenueOf(event.id))}
                      <span className="table__sub">
                        {formatCount(paidOrdersOf(event.id))} paid{" "}
                        {paidOrdersOf(event.id) === 1 ? "order" : "orders"}
                      </span>
                    </td>
                    <td>
                      <Link
                        className="btn btn--ghost btn--small"
                        href={`/admin/events/${encodeURIComponent(event.id)}`}
                      >
                        <PencilIcon size={16} /> Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="admin__panel">
        <div className="admin__panel-head">
          <h2>Orders by state</h2>
          <p className="muted">All events above together. Refreshed every 5 seconds.</p>
        </div>
        <table className="bars">
          <thead className="visually-hidden">
            <tr>
              <th scope="col">State</th>
              <th scope="col">Orders</th>
              <th scope="col">Tickets</th>
            </tr>
          </thead>
          <tbody>
            {ORDER_STATES.map(([state, label]) => {
              const total = byState.get(state) ?? { orders: 0, units: 0 };
              return (
                <tr
                  key={state}
                  title={`${label}: ${formatCount(total.orders)} orders, ${formatCount(total.units)} tickets`}
                >
                  <th scope="row" className="bars__label">
                    {label}
                  </th>
                  <td className="bars__data">
                    <div className="bars__track">
                      <span
                        className="bars__bar"
                        style={{ width: `${(total.orders / mostOrders) * 100}%` }}
                      />
                      <span className="bars__value" data-testid={`orders-${state}`}>
                        {formatCount(total.orders)}
                      </span>
                    </div>
                  </td>
                  <td className="bars__units">
                    {formatCount(total.units)} {total.units === 1 ? "ticket" : "tickets"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {unlistedOrders > 0 ? (
          <p className="admin__footnote">
            Not counted here: {formatCount(unlistedOrders)}{" "}
            {unlistedOrders === 1 ? "order" : "orders"} of events that are not in the catalogue.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default function AdminPage() {
  return (
    <AdminGate>
      <Dashboard />
    </AdminGate>
  );
}
