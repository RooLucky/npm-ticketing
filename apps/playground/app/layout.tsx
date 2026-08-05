import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ticketing package playground",
  description: "Integration fixture for @quanby/ticketing",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
