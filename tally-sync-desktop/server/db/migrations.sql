-- Payment Cycles Table
CREATE TABLE IF NOT EXISTS payment_cycles (
    id SERIAL PRIMARY KEY,
    vendor_id INTEGER REFERENCES vendors(id),
    customer_id INTEGER REFERENCES customers(id),
    entity_type VARCHAR(20), -- 'vendor' or 'customer'
    avg_settlement_days NUMERIC(10,2),
    min_settlement_days INTEGER,
    max_settlement_days INTEGER,
    payment_count INTEGER,
    on_time_count INTEGER,
    delayed_count INTEGER,
    on_time_percentage NUMERIC(5,2),
    calculated_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Outstanding Balances (Aging)
CREATE TABLE IF NOT EXISTS outstanding_aging (
    id SERIAL PRIMARY KEY,
    vendor_id INTEGER REFERENCES vendors(id),
    customer_id INTEGER REFERENCES customers(id),
    entity_type VARCHAR(20),
    current_0_30_days NUMERIC(15,2) DEFAULT 0,
    current_31_60_days NUMERIC(15,2) DEFAULT 0,
    current_61_90_days NUMERIC(15,2) DEFAULT 0,
    current_over_90_days NUMERIC(15,2) DEFAULT 0,
    total_outstanding NUMERIC(15,2) DEFAULT 0,
    calculated_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Vendor Scores
CREATE TABLE IF NOT EXISTS vendor_scores (
    id SERIAL PRIMARY KEY,
    vendor_id INTEGER REFERENCES vendors(id) UNIQUE,
    reliability_score NUMERIC(5,2), -- 0-100
    payment_history_score NUMERIC(5,2),
    volume_score NUMERIC(5,2),
    overall_score NUMERIC(5,2),
    risk_level VARCHAR(20), -- 'low', 'medium', 'high'
    notes TEXT,
    calculated_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Payment Delays/Anomalies
CREATE TABLE IF NOT EXISTS payment_anomalies (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER REFERENCES transactions(id),
    vendor_id INTEGER,
    customer_id INTEGER,
    anomaly_type VARCHAR(50), -- 'unusual_amount', 'late_payment', 'early_payment'
    expected_value NUMERIC(15,2),
    actual_value NUMERIC(15,2),
    deviation_percentage NUMERIC(5,2),
    severity VARCHAR(20), -- 'low', 'medium', 'high'
    detected_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- AI Insights Cache
CREATE TABLE IF NOT EXISTS ai_insights (
    id SERIAL PRIMARY KEY,
    insight_type VARCHAR(50), -- 'vendor_risk', 'payment_delay', 'cashflow_prediction'
    title VARCHAR(255),
    description TEXT,
    severity VARCHAR(20),
    confidence NUMERIC(5,2),
    data JSONB, -- Flexible data storage
    valid_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Cashflow Predictions
CREATE TABLE IF NOT EXISTS cashflow_predictions (
    id SERIAL PRIMARY KEY,
    prediction_date DATE,
    expected_inflow NUMERIC(15,2),
    expected_outflow NUMERIC(15,2),
    net_cashflow NUMERIC(15,2),
    confidence NUMERIC(5,2),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX idx_payment_cycles_vendor ON payment_cycles(vendor_id);
CREATE INDEX idx_payment_cycles_customer ON payment_cycles(customer_id);
CREATE INDEX idx_outstanding_vendor ON outstanding_aging(vendor_id);
CREATE INDEX idx_outstanding_customer ON outstanding_aging(customer_id);
CREATE INDEX idx_vendor_scores_vendor ON vendor_scores(vendor_id);
CREATE INDEX idx_anomalies_transaction ON payment_anomalies(transaction_id);
CREATE INDEX idx_insights_type ON ai_insights(insight_type);
CREATE INDEX idx_predictions_date ON cashflow_predictions(prediction_date);