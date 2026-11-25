// Product name as people see it: the installation's own name when it has one, else the catalog default of the locale.
import { brand } from "../messages/common";
import { instanceProductName } from "./runtime";

/** The name of the product in the current locale ("Prisma Memory" in English unless the installation names it). */
export function productName(): string {
  return instanceProductName() ?? brand.product;
}
