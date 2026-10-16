`sample.7z` and `sample.tar.gz` contain synthetic text generated for these tests:
40,000 repetitions of `Archive Ripper extraction fixture\n`. The 7z was generated
with 7-Zip; the gzip TAR with Python's standard library. Outputs exceed 1 MiB to
exercise chunked decoding.

`rar5-stored.uu` and `rar5-solid.uu` are the small libarchive fixtures
`test_read_format_rar5_stored.rar.uu` and
`test_read_format_rar5_multiple_files_solid.rar.uu`, from
https://github.com/libarchive/libarchive/tree/master/libarchive/test.
Their `.rar` files are decoded uuencoded data. The upstream license is included
in `licenses/libarchive-COPYING.txt`.

RAR4 fixtures `rar4-subblock.uu` and `rar4-encrypted.uu` use upstream's
`test_read_format_rar_subblock.rar.uu` and `test_read_format_rar4_encrypted.rar.uu`
from the same test directory.
