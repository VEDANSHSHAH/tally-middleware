-- Add company_guid to payment_cycles table
-- Run this in your Neon PostgreSQL database

-- Add company_guid column
ALTER TABLE payment_cycles ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_payment_cycles_company ON payment_cycles(company_guid);

-- Verify the column was added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'payment_cycles' AND column_name = 'company_guid';


