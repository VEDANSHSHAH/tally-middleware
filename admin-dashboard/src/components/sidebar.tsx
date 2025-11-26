"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
    LayoutDashboard,
    Building2,
    Receipt,
    Users,
    UserCircle,
    Settings,
    Database,
} from "lucide-react";

const routes = [
    {
        label: "Dashboard",
        icon: LayoutDashboard,
        href: "/",
        color: "text-sky-500",
    },
    {
        label: "Companies",
        icon: Building2,
        href: "/companies",
        color: "text-violet-500",
    },
    {
        label: "Transactions",
        icon: Receipt,
        href: "/transactions",
        color: "text-pink-700",
    },
    {
        label: "All Vendors",
        icon: Users,
        href: "/vendors",
        color: "text-orange-700",
    },
    {
        label: "All Customers",
        icon: UserCircle,
        href: "/customers",
        color: "text-emerald-500",
    },
    {
        label: "DB",
        icon: Database,
        href: "/db",
        color: "text-blue-500",
    },
];

export function Sidebar() {
    const pathname = usePathname();

    return (
        <div className="space-y-4 py-4 flex flex-col h-full bg-[#111827] text-white">
            <div className="px-3 py-2 flex-1">
                <Link href="/" className="flex items-center pl-3 mb-14">
                    <div className="relative w-8 h-8 mr-4">
                        {/* Logo placeholder */}
                        <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center text-black font-bold">T</div>
                    </div>
                    <h1 className="text-2xl font-bold">
                        Tally Admin
                    </h1>
                </Link>
                <div className="space-y-1">
                    {routes.map((route) => (
                        <Link
                            key={route.href}
                            href={route.href}
                            className={cn(
                                "text-sm group flex p-3 w-full justify-start font-medium cursor-pointer hover:text-white hover:bg-white/10 rounded-lg transition",
                                pathname === route.href ? "text-white bg-white/10" : "text-zinc-400"
                            )}
                        >
                            <div className="flex items-center flex-1">
                                <route.icon className={cn("h-5 w-5 mr-3", route.color)} />
                                {route.label}
                            </div>
                        </Link>
                    ))}
                </div>
            </div>
        </div>
    );
}
