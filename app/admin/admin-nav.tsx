"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils/cn";

/**
 * AdminNav — active-tab indicator for the admin chrome.
 *
 * Uses `usePathname()` (Client Component) to highlight the link matching the
 * current route. Sub-routes (e.g. `/admin/sessions/abc-…`) keep the parent
 * `Sessions` tab active via startsWith().
 *
 * `/admin` itself uses an EXACT match — otherwise every sub-route would also
 * light up the Dashboard link.
 */
const LINKS: { href: string; label: string; match: "exact" | "prefix" }[] = [
  { href: "/admin", label: "Dashboard", match: "exact" },
  { href: "/admin/sessions", label: "Sessions", match: "prefix" },
  { href: "/admin/queries", label: "Queries", match: "prefix" },
  { href: "/admin/kb", label: "Knowledge base", match: "prefix" },
  { href: "/admin/health", label: "Health", match: "prefix" },
];

export function AdminNav() {
  const pathname = usePathname() ?? "";

  return (
    <nav className="flex items-center gap-1" aria-label="Admin navigation">
      {LINKS.map((l) => {
        const active =
          l.match === "exact"
            ? pathname === l.href
            : pathname === l.href || pathname.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-full px-3 py-1 text-xs transition",
              active
                ? "bg-ink text-paper"
                : "text-ink-soft hover:bg-paper-soft hover:text-ink",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
