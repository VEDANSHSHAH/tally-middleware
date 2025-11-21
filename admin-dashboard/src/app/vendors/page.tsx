import { db } from "@/lib/db";
import { vendors } from "@/lib/schema";
import { DataTable } from "@/components/ui/data-table";
import { columns } from "./columns";

async function getData() {
    const data = await db
        .select({
            id: vendors.id,
            guid: vendors.guid,
            companyGuid: vendors.companyGuid,
            name: vendors.name,
            currentBalance: vendors.currentBalance,
            openingBalance: vendors.openingBalance,
        })
        .from(vendors);
    return data;
}

export default async function VendorsPage() {
    const data = await getData();

    return (
        <div className="container mx-auto py-10">
            <h1 className="text-2xl font-bold mb-5">Vendors</h1>
            <DataTable columns={columns} data={data} searchKey="name" />
        </div>
    );
}
