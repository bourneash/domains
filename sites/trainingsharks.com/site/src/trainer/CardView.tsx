import { RANKS, SUIT_GLYPH, SUIT_VAR, rankOf, suitOf, type Card } from "../lib/cards";

export function CardView({
  card,
  size = "md",
  facedown = false
}: {
  card?: Card;
  size?: "sm" | "md" | "lg";
  facedown?: boolean;
}) {
  if (facedown || card === undefined) {
    return <div className={`pcard pcard--${size} pcard--back`} aria-label="Face-down card" />;
  }
  const s = suitOf(card);
  return (
    <div
      className={`pcard pcard--${size}`}
      style={{ color: SUIT_VAR[s] }}
      aria-label={`${RANKS[rankOf(card)]}${SUIT_GLYPH[s]}`}
    >
      <span className="pcard__rank">{RANKS[rankOf(card)]}</span>
      <span className="pcard__suit">{SUIT_GLYPH[s]}</span>
    </div>
  );
}

export function CardRow({
  cards,
  size = "md",
  placeholders = 0
}: {
  cards: Card[];
  size?: "sm" | "md" | "lg";
  placeholders?: number;
}) {
  const blanks = Math.max(0, placeholders - cards.length);
  return (
    <div className="pcard-row">
      {cards.map((c, i) => (
        <CardView key={`${c}-${i}`} card={c} size={size} />
      ))}
      {Array.from({ length: blanks }, (_, i) => (
        <div key={`b${i}`} className={`pcard pcard--${size} pcard--empty`} aria-hidden="true" />
      ))}
    </div>
  );
}
