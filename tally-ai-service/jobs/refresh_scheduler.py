from apscheduler.schedulers.asyncio import AsyncIOScheduler
import asyncpg
import os
import logging
from datetime import datetime

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def get_db_pool():
  return await asyncpg.create_pool(
    os.getenv("DATABASE_URL"),
    min_size=2,
    max_size=10,
  )


async def refresh_company_aging(company_guid: str):
  pool = await get_db_pool()
  try:
    async with pool.acquire() as conn:
      async with conn.transaction():
        await conn.execute(
          """
          UPDATE vouchers v
          SET 
            amount_paid = COALESCE((
              SELECT SUM(pr.allocated_amount)
              FROM payment_references pr
              WHERE pr.invoice_voucher_id = v.id AND pr.is_active = TRUE
            ), 0),
            amount_outstanding = v.total_amount - COALESCE((
              SELECT SUM(pr.allocated_amount)
              FROM payment_references pr
              WHERE pr.invoice_voucher_id = v.id AND pr.is_active = TRUE
            ), 0),
            payment_status = CASE
              WHEN v.is_cancelled THEN 'CANCELLED'
              WHEN COALESCE((
                SELECT SUM(pr.allocated_amount)
                FROM payment_references pr
                WHERE pr.invoice_voucher_id = v.id AND pr.is_active = TRUE
              ), 0) >= v.total_amount THEN 'PAID'
              WHEN COALESCE((
                SELECT SUM(pr.allocated_amount)
                FROM payment_references pr
                WHERE pr.invoice_voucher_id = v.id AND pr.is_active = TRUE
              ), 0) > 0 THEN 'PARTIAL'
              ELSE 'UNPAID'
            END,
            aging_bucket = CASE 
              WHEN CURRENT_DATE - COALESCE(v.due_date, v.date) <= 30 THEN '0-30'
              WHEN CURRENT_DATE - COALESCE(v.due_date, v.date) <= 60 THEN '31-60'
              WHEN CURRENT_DATE - COALESCE(v.due_date, v.date) <= 90 THEN '61-90'
              ELSE '90+'
            END,
            payment_computed_at = NOW()
          WHERE v.company_guid = $1
            AND v.voucher_type IN ('SALES', 'Invoice')
            AND v.is_cancelled = FALSE
          """,
          company_guid,
        )

        await conn.execute(
          """
          UPDATE ledgers l
          SET 
            days_overdue = COALESCE(
              CURRENT_DATE - (
                SELECT MIN(v.date)
                FROM vouchers v
                WHERE v.party_ledger_id = l.id
                  AND v.payment_status IN ('UNPAID', 'PARTIAL')
              ), 
              0
            ),
            aging_computed_at = NOW()
          WHERE l.company_guid = $1
            AND l.parent_group = 'Sundry Debtors'
          """,
          company_guid,
        )

        await conn.execute(
          """
          INSERT INTO dashboard_metrics (
            company_guid, total_receivable, receivable_0_30,
            receivable_31_60, receivable_61_90, receivable_90_plus,
            customer_count, calculated_at, data_as_of_date
          )
          SELECT 
            $1,
            COALESCE((
              SELECT SUM(current_balance) 
              FROM ledgers 
              WHERE company_guid = $1 
                AND parent_group = 'Sundry Debtors' 
                AND current_balance > 0
            ), 0),
            COALESCE((
              SELECT SUM(amount_outstanding) 
              FROM vouchers 
              WHERE company_guid = $1 
                AND aging_bucket = '0-30' 
                AND payment_status IN ('UNPAID', 'PARTIAL')
            ), 0),
            COALESCE((
              SELECT SUM(amount_outstanding) 
              FROM vouchers 
              WHERE company_guid = $1 
                AND aging_bucket = '31-60' 
                AND payment_status IN ('UNPAID', 'PARTIAL')
            ), 0),
            COALESCE((
              SELECT SUM(amount_outstanding) 
              FROM vouchers 
              WHERE company_guid = $1 
                AND aging_bucket = '61-90' 
                AND payment_status IN ('UNPAID', 'PARTIAL')
            ), 0),
            COALESCE((
              SELECT SUM(amount_outstanding) 
              FROM vouchers 
              WHERE company_guid = $1 
                AND aging_bucket = '90+' 
                AND payment_status IN ('UNPAID', 'PARTIAL')
            ), 0),
            COALESCE((
              SELECT COUNT(*) 
              FROM ledgers 
              WHERE company_guid = $1 
                AND parent_group = 'Sundry Debtors' 
                AND current_balance > 0
            ), 0),
            NOW(), CURRENT_DATE
          ON CONFLICT (company_guid, data_as_of_date) DO UPDATE SET
            total_receivable = EXCLUDED.total_receivable,
            receivable_0_30 = EXCLUDED.receivable_0_30,
            receivable_31_60 = EXCLUDED.receivable_31_60,
            receivable_61_90 = EXCLUDED.receivable_61_90,
            receivable_90_plus = EXCLUDED.receivable_90_plus,
            customer_count = EXCLUDED.customer_count,
            calculated_at = EXCLUDED.calculated_at
          """,
          company_guid,
        )

        logger.info(f"✅ Aging refreshed for {company_guid}")
  except Exception as e:
    logger.error(f"❌ Failed to refresh {company_guid}: {str(e)}")
    raise
  finally:
    await pool.close()


async def refresh_all_companies():
  logger.info("⏰ Starting aging refresh for all companies...")
  pool = await get_db_pool()
  try:
    async with pool.acquire() as conn:
      companies = await conn.fetch(
        """
        SELECT company_guid 
        FROM companies 
        WHERE active = TRUE
        """
      )

      logger.info(f"Found {len(companies)} active companies")

      for company in companies:
        try:
          await refresh_company_aging(company["company_guid"])
        except Exception as e:
          logger.error(f"Failed to refresh {company['company_guid']}: {str(e)}")

      logger.info("✅ Aging refresh completed for all companies")
  finally:
    await pool.close()


scheduler = AsyncIOScheduler()


def start_scheduler():
  scheduler.add_job(
    refresh_all_companies,
    "interval",
    minutes=5,
    id="refresh_aging",
    replace_existing=True,
  )

  scheduler.add_job(
    refresh_all_companies,
    "date",
    run_date=datetime.now(),
    id="refresh_aging_startup",
  )

  scheduler.start()
  logger.info("✅ Aging refresh scheduler started (runs every 5 minutes)")


def stop_scheduler():
  scheduler.shutdown()
  logger.info("Scheduler stopped")
