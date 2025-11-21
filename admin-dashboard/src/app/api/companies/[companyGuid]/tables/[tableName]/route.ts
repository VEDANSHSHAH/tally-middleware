import { pool } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
    request: NextRequest,
    context: { 
        params: Promise<{ companyGuid: string; tableName: string }> | { companyGuid: string; tableName: string } 
    }
) {
    try {
        const params = await (context.params instanceof Promise ? context.params : Promise.resolve(context.params));
        const { companyGuid, tableName } = params;
        
        // Validate inputs
        if (!/^[a-f0-9-]{36}$/i.test(companyGuid)) {
            return NextResponse.json(
                { error: "Invalid company GUID format" },
                { status: 400 }
            );
        }

        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
            return NextResponse.json(
                { error: "Invalid table name" },
                { status: 400 }
            );
        }

        // Verify table has company_guid column
        const hasCompanyGuid = await pool.query(`
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                AND table_name = $1
                AND column_name = 'company_guid'
            )
        `, [tableName]);

        if (!hasCompanyGuid.rows[0].exists) {
            return NextResponse.json(
                { error: "Table does not have company_guid column" },
                { status: 400 }
            );
        }

        // Get table data filtered by company_guid
        const searchParams = request.nextUrl.searchParams;
        const limit = parseInt(searchParams.get("limit") || "50", 10);
        const offset = parseInt(searchParams.get("offset") || "0", 10);

        const result = await pool.query(`
            SELECT * FROM "${tableName}"
            WHERE company_guid = $1
            LIMIT $2 OFFSET $3
        `, [companyGuid, limit, offset]);

        return NextResponse.json({
            data: result.rows,
            columns: result.fields.map(field => field.name),
        });
    } catch (error: any) {
        console.error("Error fetching company table data:", error);
        return NextResponse.json(
            { error: error.message || "Failed to fetch table data" },
            { status: 500 }
        );
    }
}

