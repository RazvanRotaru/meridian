import type { ReactElement } from "react";
import { NavBar } from "./NavBar.js";
import { CatalogPage } from "./CatalogPage.js";
import { CartPanel } from "./CartPanel.js";
import { Footer } from "./Footer.js";

/** The page shell. Composes the nav, the catalog, the cart, and the footer. */
export function StoreLayout(): ReactElement {
  return (
    <div className="store-layout">
      <NavBar />
      <main>
        <CatalogPage />
        <CartPanel />
      </main>
      <Footer />
    </div>
  );
}
