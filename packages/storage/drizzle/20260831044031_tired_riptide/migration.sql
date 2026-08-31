CREATE TABLE `worktree_checkout_generations` (
	`ownership_id` text PRIMARY KEY,
	`git_admin_device` text NOT NULL,
	`git_admin_inode` text NOT NULL,
	`git_admin_birthtime_ns` text NOT NULL,
	`marker_device` text NOT NULL,
	`marker_inode` text NOT NULL,
	`marker_birthtime_ns` text NOT NULL,
	CONSTRAINT `fk_worktree_checkout_generations_ownership_id_worktree_ownerships_id_fk` FOREIGN KEY (`ownership_id`) REFERENCES `worktree_ownerships`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT "worktree_checkout_generations_identity_check" CHECK(length("git_admin_device") between 1 and 20
        and "git_admin_device" not glob '*[^0-9]*'
        and (length("git_admin_device") = 1 or substr("git_admin_device", 1, 1) != '0')
        and length("git_admin_inode") between 1 and 20
        and "git_admin_inode" not glob '*[^0-9]*'
        and (length("git_admin_inode") = 1 or substr("git_admin_inode", 1, 1) != '0')
        and length("git_admin_birthtime_ns") between 1 and 20
        and "git_admin_birthtime_ns" not glob '*[^0-9]*'
        and (length("git_admin_birthtime_ns") = 1 or substr("git_admin_birthtime_ns", 1, 1) != '0')
        and length("marker_device") between 1 and 20
        and "marker_device" not glob '*[^0-9]*'
        and (length("marker_device") = 1 or substr("marker_device", 1, 1) != '0')
        and length("marker_inode") between 1 and 20
        and "marker_inode" not glob '*[^0-9]*'
        and (length("marker_inode") = 1 or substr("marker_inode", 1, 1) != '0')
        and length("marker_birthtime_ns") between 1 and 20
        and "marker_birthtime_ns" not glob '*[^0-9]*'
        and (length("marker_birthtime_ns") = 1 or substr("marker_birthtime_ns", 1, 1) != '0'))
);
