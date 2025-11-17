from utils.database import get_vendors, get_vendor_scores, get_transactions, get_outstanding_aging

print("Testing database connections...\n")

print("1. Testing vendors:")
vendors = get_vendors()
print(f"   Found {len(vendors)} vendors")
if vendors:
    print(f"   Sample: {vendors[0]}")

print("\n2. Testing vendor scores:")
scores = get_vendor_scores()
print(f"   Found {len(scores)} vendor scores")
if scores:
    print(f"   Sample: {scores[0]}")

print("\n3. Testing transactions:")
transactions = get_transactions()
print(f"   Found {len(transactions)} transactions")
if transactions:
    print(f"   Sample: {transactions[0]}")

print("\n4. Testing aging:")
aging = get_outstanding_aging()
print(f"   Found {len(aging)} aging records")
if aging:
    print(f"   Sample: {aging[0]}")