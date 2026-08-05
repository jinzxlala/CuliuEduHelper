"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { JSX } from "react";

const navigationItems = [
  { href: "/", label: "首页", matches: (pathname: string) => pathname === "/" },
  {
    href: "/students",
    label: "学生档案",
    matches: (pathname: string) =>
      pathname === "/students" ||
      (pathname.startsWith("/students/") && pathname !== "/students/import"),
  },
  {
    href: "/students/import",
    label: "批量建档",
    matches: (pathname: string) => pathname === "/students/import",
  },
  {
    href: "/courses",
    label: "课程模板",
    matches: (pathname: string) => pathname === "/courses",
  },
  {
    href: "/scheduling",
    label: "课程排课",
    matches: (pathname: string) => pathname === "/scheduling",
  },
] as const;

export function AppNavigation(): JSX.Element {
  const pathname = usePathname();
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link aria-label="醋溜教育教务系统首页" className="site-logo" href="/">
          <Image
            alt="醋溜科技 Culiu Tech"
            height={125}
            priority
            src="/brand/culiu-tech-logo.png"
            width={310}
          />
        </Link>
        <nav aria-label="主要页面" className="site-tabs">
          {navigationItems.map((item) => {
            const active = item.matches(pathname);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={active ? "active" : undefined}
                href={item.href}
                key={item.href}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
