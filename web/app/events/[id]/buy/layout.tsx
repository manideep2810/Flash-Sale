import type { ReactNode } from "react";

// The tab's title for as long as it is the user's turn. The waiting room sets the same words the
// instant the user is admitted (so a tab in the background shows them at once); this keeps them once
// the navigation here has settled, when the root layout's title would otherwise come back.
export const metadata = {
  title: "It's your turn!",
};

export default function BuyLayout({ children }: { children: ReactNode }) {
  return children;
}
