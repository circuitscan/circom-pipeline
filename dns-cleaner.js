const apiToken = process.env.CLOUDFLARE_TOKEN;
const zoneId = process.env.ZONE_ID;

// Function to list all DNS records in a Cloudflare zone
async function listDNSRecords() {
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json();
  if (!data.success) {
    throw new Error(`Failed to list DNS records: ${data.errors.map(e => e.message).join(', ')}`);
  }
  return data.result;
}

// Function to delete a DNS record by ID
async function deleteDNSRecord(recordId) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json();
  if (!data.success) {
    throw new Error(`Failed to delete DNS record: ${data.errors.map(e => e.message).join(', ')}`);
  }
  return data.result;
}

// Main function to list and delete DNS records with names starting with "circom-compiler"
async function main() {
  try {
    const dnsRecords = await listDNSRecords();
    const recordsToDelete = dnsRecords.filter(record => record.name.startsWith('circom-compiler'));

    for (const record of recordsToDelete) {
      console.log(`Deleting DNS record: ${record.name} (ID: ${record.id})`);
      await deleteDNSRecord(record.id);
      console.log(`Deleted DNS record: ${record.name}`);
    }

    console.log('Completed deletion of DNS records.');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
