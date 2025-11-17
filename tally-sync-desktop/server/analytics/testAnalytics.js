const { 
  calculateVendorSettlementCycles,
  calculateOutstandingAging,
  calculateVendorScores
} = require('./paymentCycles');

async function testAnalytics() {
  try {
    console.log('🧪 Testing Analytics Functions...\n');
    
    // Test 1: Settlement Cycles
    console.log('1️⃣ Testing Settlement Cycles...');
    await calculateVendorSettlementCycles();
    console.log('   ✅ Settlement cycles calculated\n');
    
    // Test 2: Outstanding Aging
    console.log('2️⃣ Testing Outstanding Aging...');
    await calculateOutstandingAging();
    console.log('   ✅ Outstanding aging calculated\n');
    
    // Test 3: Vendor Scores
    console.log('3️⃣ Testing Vendor Scores...');
    await calculateVendorScores();
    console.log('   ✅ Vendor scores calculated\n');
    
    console.log('🎉 All analytics tests passed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Analytics test failed:', error.message);
    process.exit(1);
  }
}

testAnalytics();