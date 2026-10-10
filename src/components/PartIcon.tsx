export default function PartIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const common = {
    className: className ?? "h-6 w-6",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (name === "sentence") {
    return (
      <svg viewBox="0 0 24 24" {...common}>
        <path d="M4 7h10" />
        <path d="M4 12h16" />
        <path d="M4 17h7" />
      </svg>
    );
  }

  if (name === "text") {
    return (
      <svg viewBox="0 0 24 24" {...common}>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M8 9h8" />
        <path d="M8 12h8" />
        <path d="M8 15h5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" {...common}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M9 7h6" />
      <path d="M9 11h6" />
    </svg>
  );
}
