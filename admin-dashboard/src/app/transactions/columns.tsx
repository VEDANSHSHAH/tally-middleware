"use client";

import { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";

export type Transaction = {
    id: number;
    guid: string;
    companyGuid: string;
    voucherNumber: string | null;
    voucherType: string;
    date: string;
    partyName: string | null;
    amount: string;
    narration: string | null;
};

export const columns: ColumnDef<Transaction>[] = [
    {
        accessorKey: "date",
        header: ({ column }) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                >
                    Date
                    <ArrowUpDown className="ml-2 h-4 w-4" />
                </Button>
            );
        },
        cell: ({ row }) => {
            const date = row.getValue("date");
            return date ? new Date(date as string).toLocaleDateString() : "";
        }
    },
    {
        accessorKey: "companyGuid",
        header: "Company GUID",
        cell: ({ row }) => <div className="text-xs text-muted-foreground">{row.getValue("companyGuid")}</div>
    },
    {
        accessorKey: "voucherType",
        header: "Type",
    },
    {
        accessorKey: "voucherNumber",
        header: "Voucher No",
    },
    {
        accessorKey: "partyName",
        header: "Party Name",
    },
    {
        accessorKey: "amount",
        header: ({ column }) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                >
                    Amount
                    <ArrowUpDown className="ml-2 h-4 w-4" />
                </Button>
            );
        },
        cell: ({ row }) => {
            const amount = parseFloat(row.getValue("amount"));
            const formatted = new Intl.NumberFormat("en-IN", {
                style: "currency",
                currency: "INR",
            }).format(amount);
            return <div className="font-medium">{formatted}</div>;
        },
    },
    {
        accessorKey: "narration",
        header: "Narration",
        cell: ({ row }) => {
            const raw = row.getValue("narration") as string;
            if (!raw) return "";

            try {
                if (raw.trim().startsWith("{")) {
                    const parsed = JSON.parse(raw);
                    if (typeof parsed === "object" && parsed !== null) {
                        if (parsed._) return <div className="truncate max-w-[200px]" title={parsed._}>{parsed._}</div>;
                        if (parsed.$ && Object.keys(parsed).length === 1) return "";
                    }
                }
                return <div className="truncate max-w-[200px]" title={raw}>{raw}</div>;
            } catch (e) {
                return <div className="truncate max-w-[200px]" title={raw}>{raw}</div>;
            }
        }
    },
];
