import { Outlet } from "react-router-dom";
import { Header } from "./Header";
import { Footer } from "./Footer";

export function SiteLayout() {
  return (
    <div className="site" style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <Header />
      <Outlet />
      <Footer />
    </div>
  );
}
