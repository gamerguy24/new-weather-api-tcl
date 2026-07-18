import bz2 from 'bz2';
export function bunzip(u8) { return bz2.decompress(u8); }
