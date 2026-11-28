/**
 * Rules for a hardened listening set. The Skill says to decide the public ports
 * before scanning, so the reader compares every open port against this list.
 */
export const EXPECTED_PUBLIC_PORTS: ReadonlySet<string> = new Set(['80', '443']);

/** Open ports that are a finding whenever they answer on a public interface. */
export const DATASTORE_PORTS: ReadonlySet<string> = new Set([
  '1433', '3306', '5432', '6379', '9200', '9000', '8888', '27017', '11211', '5672',
]);

/** Service ports reported next to the URL's own port by a representative sweep. */
export const SWEEP_PORTS = '21,22,25,80,443,445,1433,3000,3306,5432,6379,8000,8080,8443,8888,9200,27017';
