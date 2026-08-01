# 2026-01-01 00:00:00 by RouterOS 7.21.5
# software id = XXXX-XXXX
#
# model = hAP ax^2
# serial number = 0000000000
#
# Constructs that break naive parsers. Every line here is valid RouterOS.
/interface wifi channel
add band=5ghz-ax disabled=no frequency="5180-5240:20,5260-5320:20,5500-5560:20\
    ,5580-5640:20,5660-5720:20,5745-5805:20" name=ch-5ax-80 \
    reselect-interval=1d12h..2d secondary-frequency=disabled \
    skip-dfs-channels=10min-cac width=20/40/80mhz
/interface wifi security
add authentication-types=wpa2-psk,wpa3-psk dh-groups=19,20,21 disabled=no \
    ft=yes ft-mobility-domain=0xABCD ft-over-ds=yes ft-r0-key-lifetime=12h \
    ft-reassociation-deadline=30s group-encryption=ccmp group-key-update=30m \
    management-encryption=cmac management-protection=allowed name=sec-main \
    sae-anti-clogging-threshold=3 sae-max-failure-rate=3 sae-pwe=both \
    wps=disable
/interface wifi
# Dotted sub-properties, and a leading dot continuing the previous group.
set [ find default-name=wifi1 ] channel=ch-5ax-80 channel.frequency=\
    5180,5260 .secondary-frequency=disabled configuration=cfg-main \
    configuration.manager=local .mode=ap disabled=no
/interface list member
add comment="uplink to ISP" interface=ether1 list=WAN
add comment="локальная сеть" interface=bridge list=LAN
/ip firewall filter
# A quoted value containing escaped quotes.
add action=accept chain=forward comment="allow \"trusted\" hosts" \
    src-address-list=trusted
# Comments carrying non-ASCII text.
add action=drop chain=forward comment="блокировка гостевой сети" \
    in-interface=vlan200-guest out-interface-list=LAN
/ip firewall mangle
add action=mark-connection chain=prerouting comment="mark uplink" \
    connection-mark=no-mark in-interface=ether1 new-connection-mark=from-wan \
    passthrough=yes
/queue simple
add max-limit=100M/100M name="guest cap" target=192.168.20.0/24
/system scheduler
# A whole script stored as a quoted value, spanning continuations. Its
# variables are declared elsewhere and must not be judged from this file.
add interval=1d name=nightly on-event="{:local now [/system/clock/get time];\r\
    \n:if ([:len \$externalList] > 0) do={\r\
    \n    :log info (\"run at \" . \$now);\r\
    \n} else={\r\
    \n    :log warning \"nothing to do\";\r\
    \n}}" policy=read,write,test start-time=03:00:00
/system script
add dont-require-permissions=no name=check-uplink owner=admin \
    policy=read,write,test source=":local gw 192.168.1.1;\r\
    \n:if ([/ping \$gw count=3] = 0) do={\r\
    \n    :log warning \"gateway unreachable\";\r\
    \n}"
/ipv6 address
add address=2001:db8::1/64 advertise=no interface=bridge
/ipv6 firewall filter
add action=accept chain=input connection-state=established,related
/routing table
add disabled=no fib name=to-branch
