# 2026-01-01 00:00:00 by RouterOS 7.21.5
# software id = XXXX-XXXX
#
# model = RB5009UG+S+
# serial number = 0000000000
/interface bridge
add admin-mac=02:00:00:00:00:01 auto-mac=no comment=defconf name=bridge \
    port-cost-mode=short vlan-filtering=yes
/interface ethernet
set [ find default-name=ether1 ] comment="WAN uplink"
set [ find default-name=ether2 ] comment="LAN trunk" l2mtu=1514
/interface vlan
add interface=bridge name=vlan100 vlan-id=100
add arp=reply-only interface=bridge name=vlan200-guest vlan-id=200
/interface list
add comment=defconf name=WAN
add comment=defconf name=LAN
/interface wireguard
add listen-port=13231 mtu=1420 name=wg-site-a
add comment="branch tunnel" listen-port=13232 mtu=1420 name=wg-site-b
/interface wireguard peers
add allowed-address=10.10.0.0/24 endpoint-address=vpn.example.com \
    endpoint-port=13231 interface=wg-site-a name=peer-a \
    public-key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
/ip pool
add name=dhcp-lan ranges=192.168.10.10-192.168.10.254
/ip dhcp-server
add address-pool=dhcp-lan interface=bridge lease-time=10m name=dhcp-lan
/ip address
add address=192.168.10.1/24 comment=defconf interface=bridge network=192.168.10.0
add address=10.10.0.1/24 interface=wg-site-a network=10.10.0.0
/ip dns
set allow-remote-requests=yes servers=1.1.1.1,8.8.8.8
/ip firewall address-list
add address=0.0.0.0/8 comment="\"this\" network" list=BOGONS
add address=10.0.0.0/8 list=RFC1918
add address=192.0.2.0/24 comment="TEST-NET-1" list=BOGONS
/ip firewall filter
add action=accept chain=input comment="defconf: accept established" \
    connection-state=established,related
add action=drop chain=input comment="defconf: drop invalid" \
    connection-state=invalid
add action=accept chain=input protocol=icmp
add action=drop chain=input comment="defconf: drop all not coming from LAN" \
    in-interface-list=!LAN
/ip firewall nat
add action=masquerade chain=srcnat comment="defconf: masquerade" \
    ipsec-policy=out,none out-interface-list=WAN
/ip route
add disabled=no dst-address=0.0.0.0/0 gateway=192.168.1.1 routing-table=main
add distance=10 dst-address=10.20.0.0/24 gateway=10.10.0.2
/ip service
set telnet disabled=yes
set ftp disabled=yes
set www address=192.168.10.0/24
/system clock
set time-zone-name=UTC
/system identity
set name=example-router
/system note
set show-at-login=no
/tool mac-server
set allowed-interface-list=LAN
