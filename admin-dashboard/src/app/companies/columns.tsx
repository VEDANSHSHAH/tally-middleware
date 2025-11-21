"use client";

import { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

export type Company = {
    id: number;
    companyGuid: string;
    companyName: string;
    tallyCompanyName: string | null;
    verified: boolean | null;
    registeredAt: string | null;
    lastSync: string | null;
    transactionCount: number;
    vendorCount: number;
    customerCount: number;
};

function CompanyNameCell({ companyName, companyGuid }: { companyName: string; companyGuid: string }) {
    const router = useRouter();
    return (
        <button
            onClick={(e) => {
                e.stopPropagation();
                router.push(`/companies/${companyGuid}`);
            }}
            className="text-blue-400 hover:text-blue-300 hover:underline font-medium cursor-pointer"
        >
            {companyName}
        </button>
    );
}

export const columns: ColumnDef<Company>[] = [
    {
        accessorKey: "companyName",
        header: ({ column }) => {
            return (
                <Button
                    variant="ghost"
                    onClick={(e) => {
                        e.stopPropagation();
                        column.toggleSorting(column.getIsSorted() === "asc");
                    }}
                >
                    Company Name
                    <ArrowUpDown className="ml-2 h-4 w-4" />
                </Button>
            );
        },
        cell: ({ row }) => {
            return (
                <CompanyNameCell 
                    companyName={row.getValue("companyName")} 
                    companyGuid={row.original.companyGuid}
                />
            );
        },
    },
    {
        accessorKey: "tallyCompanyName",
        header: "Tally Name",
    },
    {
        accessorKey: "companyGuid",
        header: "GUID",
    },
    {
        accessorKey: "verified",
        header: "Verified",
        cell: ({ row }) => (
            <div className={row.getValue("verified") ? "text-green-500" : "text-red-500"}>
                {row.getValue("verified") ? "Yes" : "No"}
            </div>
        ),
    },
    {
        accessorKey: "transactionCount",
        header: "Transactions",
        cell: ({ row }) => <div className="text-center font-medium">{row.getValue("transactionCount")}</div>,
    },
    {
        accessorKey: "vendorCount",
        header: "Vendors",
        cell: ({ row }) => <div className="text-center font-medium">{row.getValue("vendorCount")}</div>,
    },
    {
        accessorKey: "customerCount",
        header: "Customers",
        cell: ({ row }) => <div className="text-center font-medium">{row.getValue("customerCount")}</div>,
    },
    {
        accessorKey: "lastSync",
        header: "Last Sync",
        cell: ({ row }) => {
            const date = row.getValue("lastSync");
            if (!date) return "Never";
            return new Date(date as string).toLocaleString();
        }
    },
];
