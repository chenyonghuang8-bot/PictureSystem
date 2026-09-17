import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@family-album/ui-tokens/tokens.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "张家的时光",
  description: "Private family album foundation",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
