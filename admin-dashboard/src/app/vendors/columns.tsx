"use client";

import { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";

export type Vendor = {
    id: number;
    guid: string;
    companyGuid: string;
    name: string;
    currentBalance: string | null;
    openingBalance: string | null;
};

export const columns: ColumnDef<Vendor>[] = [
    {
        accessorKey: "name",
        header: ({ column }) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                >
                    Name
                    <ArrowUpDown className="ml-2 h-4 w-4" />
                </Button>
            );
        },
    },
    {
        accessorKey: "companyGuid",
        header: "Company GUID",
        cell: ({ row }) => <div className="text-xs text-muted-foreground">{row.getValue("companyGuid")}</div>
    },
    {
        accessorKey: "currentBalance",
        header: ({ column }) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                >
                    Current Balance
                    <ArrowUpDown className="ml-2 h-4 w-4" />
                </Button>
            );
        },
        cell: ({ row }) => {
            const amount = parseFloat(row.getValue("currentBalance") || "0");
            const formatted = new Intl.NumberFormat("en-IN", {
                style: "currency",
                currency: "INR",
            }).format(amount);
            return <div className={amount < 0 ? "text-red-500" : "text-green-500"}>{formatted}</div>;
        },
    },
    {
        accessorKey: "openingBalance",
        header: "Opening Balance",
        cell: ({ row }) => {
            const amount = parseFloat(row.getValue("openingBalance") || "0");
            const formatted = new Intl.NumberFormat("en-IN", {
                style: "currency",
                currency: "INR",
            }).format(amount);
            return <div>{formatted}</div>;
        },
    },
];
