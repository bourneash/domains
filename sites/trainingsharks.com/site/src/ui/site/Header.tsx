import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { to: "/help", label: "How it works" },
  { to: "/opponents", label: "Opponents" },
  { to: "/about", label: "About" }
];

export function Header() {
  const [open, setOpen] = useState(false);
  // The landing hero bleeds to the very top, so the header floats over it
  // transparently there and stays a solid sticky bar everywhere else.
  const overlay = useLocation().pathname === "/";
  return (
    <header className={overlay ? "site-header site-header--overlay" : "site-header"}>
      <div className="container site-header__inner">
        <Logo />
        <nav className={open ? "site-nav site-nav--open" : "site-nav"} onClick={() => setOpen(false)}>
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? "is-active" : "")}>
              {l.label}
            </NavLink>
          ))}
          <NavLink to="/train" className="site-nav__cta">
            Start training →
          </NavLink>
        </nav>
        <ThemeToggle />
        <button className="site-burger" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          ☰
        </button>
      </div>
    </header>
  );
}
