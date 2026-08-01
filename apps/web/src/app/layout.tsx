import type { JSX, ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: "CuliuEduHelper",
  description: "醋溜教育智能助手内部MVP",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): JSX.Element {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
