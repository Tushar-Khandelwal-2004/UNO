import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UNO Rooms",
  description: "Play UNO with friends using a room code.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
