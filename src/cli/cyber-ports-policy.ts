/**
 * Rules for a hardened listening set. The Skill says to decide the public ports
 * before scanning, so the reader compares every open port against this list.
 */
export const EXPECTED_PUBLIC_PORTS: ReadonlySet<string> = new Set(['80', '443']);

/** Open ports that are a finding whenever they answer on a public interface. */
export const DATASTORE_PORTS: ReadonlySet<string> = new Set([
  '1433', '3306', '5432', '6379', '9200', '9000', '8888', '27017', '11211', '5672',
]);

/**
 * Ports the service scan looks at. Every one of them can reveal the software in
 * its response, which is what the vulnerability probe is then run against.
 * The URL's own port is added separately so a site on an unusual port is not
 * reported as having nothing open.
 */
export const SERVICE_PORTS = '21,22,25,53,80,110,143,443,445,587,993,995,1433,1521,2049,2375,3000,3306,3389,5000,5432,5601,6379,8000,8080,8081,8443,8888,9000,9200,9300,11211,27017,27018';
