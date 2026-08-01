# RouterOS scripting. Every line here is correct — the fixture exists to prove
# the server stays quiet on working code, which matters more than catching
# mistakes: a warning on a valid config is worse than a missed typo.

:local counter 0;
:global siteName "branch-01";

# A block sees the scope that encloses it.
:if ($counter = 0) do={
    :log info ("starting on " . $siteName);
}

# Loops declare their own variable.
:foreach iface in=[/interface find] do={
    :local name [/interface get $iface name];
    :if ($name ~ "^wg-") do={
        :log info ("wireguard: " . $name);
        :set counter ($counter + 1);
    }
}

:for index from=1 to=5 do={
    :for inner from=1 to=5 do={
        :if (($index * $inner) > 12) do={
            :put ($index . "x" . $inner);
        }
    }
}

:while ($counter < 3) do={
    :set counter ($counter + 1);
}

# A function body sees its positional arguments and globals, nothing else.
:local describe do={
    :local prefix "iface: ";
    :return ($prefix . $1);
}
:put [$describe "ether1"];

# Arrays and records.
:local ports {80;443;8291};
:local labels {"http"=80; "https"=443};
:foreach port in=$ports do={
    :put $port;
}

# Command substitution, nested.
:local total [:len [/ip/firewall/filter find]];
:if ($total > 0) do={
    :put ("rules: " . $total);
}

# Both path spellings with arguments, and a positional selector.
/ip/route/add gateway=192.168.1.1 distance=1 comment="added by script"
/interface/wireguard/add name=wg-tmp listen-port=13240 mtu=1420
/ip firewall filter add chain=forward action=accept comment="from script"
/interface/wireless/set 0 disabled=yes
/ip/route/remove [find comment="added by script"]

# Values that must not be judged: computed at run time.
:local wanted 1500;
/interface/wireguard/set [find name=wg-tmp] mtu=$wanted

/tool fetch url="https://example.com/list.txt" mode=https dst-path=list.txt
