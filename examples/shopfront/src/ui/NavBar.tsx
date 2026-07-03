import type { ReactElement } from "react";
import { Logo } from "./Logo.js";
import { SearchBox } from "./SearchBox.js";
import { CartButton } from "./CartButton.js";

/** The top navigation bar. Composes the Logo, SearchBox, and CartButton. */
export function NavBar(): ReactElement {
  return (
    <nav className="navbar">
      <Logo />
      <SearchBox />
      <CartButton />
    </nav>
  );
}
