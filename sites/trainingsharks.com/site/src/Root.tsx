import { lazy, Suspense } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { SiteLayout } from "./ui/site/SiteLayout";
import { CookieBanner } from "./ui/site/CookieBanner";
import Landing from "./pages/Landing";
import Help from "./pages/Help";
import Opponents from "./pages/Opponents";
import About from "./pages/About";
import Contact from "./pages/Contact";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import NotFound from "./pages/NotFound";
import { usePageMeta } from "./lib/meta";

// The trainer pulls in the wasm engine; keep it out of the marketing bundle so
// the landing page stays light for people who are still deciding.
const Trainer = lazy(() => import("./trainer/Trainer"));

function TrainRoute() {
  usePageMeta(
    "Trainer — TrainingSharks",
    "Drill call/fold and equity spots graded in chips, play against exploitable opponents, and track your leaks.",
    "/train"
  );
  // The felt is always dark, whatever the site theme is doing.
  return (
    <div data-theme="dark" style={{ minHeight: "100%", position: "relative" }}>
      <Suspense
        fallback={
          <div
            style={{
              minHeight: "70vh",
              display: "grid",
              placeItems: "center",
              background: "#05090c",
              fontFamily: "ui-monospace, monospace",
              textAlign: "center",
              padding: "0 24px"
            }}
          >
            <div>
              <div style={{ color: "#587380", fontSize: 13 }}>Loading the solver engine…</div>
              <div style={{ color: "#3a5560", fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
                ~75 KB of Rust compiled to WebAssembly · runs entirely on your machine
                <br />
                Same seed, same answer, every time.
              </div>
            </div>
          </div>
        }
      >
        <Trainer />
      </Suspense>
    </div>
  );
}

const router = createBrowserRouter([
  { path: "/train", element: <TrainRoute /> },
  {
    element: <SiteLayout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/help", element: <Help /> },
      { path: "/opponents", element: <Opponents /> },
      { path: "/about", element: <About /> },
      { path: "/contact", element: <Contact /> },
      { path: "/privacy", element: <Privacy /> },
      { path: "/terms", element: <Terms /> },
      { path: "*", element: <NotFound /> }
    ]
  }
]);

export function Root() {
  return (
    <>
      <RouterProvider router={router} />
      <CookieBanner />
    </>
  );
}
