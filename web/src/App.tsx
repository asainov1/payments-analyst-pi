import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { Chat } from "./pages/Chat.tsx";
import { Improvements } from "./pages/Improvements.tsx";

type Page = "chat" | "improvements";

function pageFromHash(): Page {
  return location.hash === "#/improvements" ? "improvements" : "chat";
}

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [budget, setBudget] = useState<{ spent_usd: number; cap_usd: number } | null>(null);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const load = () => api.budget().then(setBudget).catch(() => setBudget(null));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="app">
      <header className="top">
        <strong>Payments analyst</strong>
        <nav>
          <a href="#/chat" className={page === "chat" ? "active" : ""}>Chat</a>
          <a href="#/improvements" className={page === "improvements" ? "active" : ""}>Improvements</a>
        </nav>
        <span className="muted" data-testid="budget">
          {budget ? `spent $${budget.spent_usd.toFixed(2)} / cap $${budget.cap_usd}` : "budget n/a"}
        </span>
      </header>
      <main>{page === "chat" ? <Chat /> : <Improvements />}</main>
    </div>
  );
}
