import { useEffect, useState } from "react";
import type { Part } from "@/lib/types";
import Dashboard from "@/pages/Dashboard";
import Practice from "@/pages/Practice";

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();

  const match = hash.match(/^#\/practice\/(part[567])$/);
  if (match) {
    const part = Number(match[1].replace("part", "")) as Part;
    return <Practice part={part} />;
  }

  return <Dashboard />;
}
