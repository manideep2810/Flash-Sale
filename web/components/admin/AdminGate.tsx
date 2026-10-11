"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useSession } from "@/lib/session";

/**
 * Around every admin page: shows it to an admin session and sends anyone else to the admin login.
 * This is for the screen's sake only. What keeps the admin API closed is the backend, which checks
 * the role in the signed session on every call.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { ready, isAdmin } = useSession();

  useEffect(() => {
    if (ready && !isAdmin) {
      router.replace("/admin/login");
    }
  }, [ready, isAdmin, router]);

  return ready && isAdmin ? children : null;
}
