/**
 * Le cadre des écrans de `/confirm` — partagé par le rendu serveur (`vue.tsx`) et le bouton
 * (`confirm-client.tsx`), pour que l'écran qui suit le clic soit exactement celui que la page
 * affichait avant le 24/09/2026. Aucun état, aucun effet : utilisable des deux côtés.
 *
 * `icone` : `ok` (coche sur la couleur de marque), `ko` (avertissement), `question` (l'enveloppe
 * de l'écran qui attend le clic).
 */
export function Shell({
  brand,
  icone,
  title,
  children,
}: {
  brand: string;
  icone: "ok" | "ko" | "question";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4" style={{ background: "#f7f7fb" }}>
      <div className="w-full max-w-[420px] rounded-2xl border bg-white p-7 text-center" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto mb-3.5 flex h-12 w-12 items-center justify-center rounded-full" style={{ background: icone === "ok" ? brand : "#f0f0f4" }}>
          {icone === "ok" ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M20 6L9 17l-5-5" /></svg>
          ) : icone === "question" ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2.2"><path d="M4 6h16v12H4z" /><path d="M4 7l8 6 8-6" /></svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2.2"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          )}
        </div>
        <h1 className="text-[19px] font-bold tracking-tight">{title}</h1>
        <div className="mt-1.5 text-[13.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{children}</div>
      </div>
    </div>
  );
}
