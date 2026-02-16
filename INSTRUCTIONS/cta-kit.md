# 🎯 CTA Kit --- Design System

Theme Base\
Background: linear-gradient(to right, #2563eb, #1d4ed8)\
Primary Accent: #fbbf24 (amber-400)

------------------------------------------------------------------------

## Button Types

  Type        Usage         Priority
  ----------- ------------- ----------
  Primary     Main action   Highest
  Secondary   Alternative   Medium
  Tertiary    Links         Low
  Icon        Compact       Context
  Danger      Destructive   Critical

------------------------------------------------------------------------

## Primary CTA

``` css
.btn-primary {
  background: #fbbf24;
  color: #1f2933;
  font-weight: 600;
  border-radius: 10px;
  padding: 12px 20px;
}
```

------------------------------------------------------------------------

## Secondary CTA

``` css
.btn-secondary {
  background: transparent;
  color: #ffffff;
  border: 2px solid rgba(255,255,255,0.85);
}
```

------------------------------------------------------------------------

## Danger Button

``` css
.btn-danger {
  background: #dc2626;
  color: #ffffff;
}
```

------------------------------------------------------------------------

## Sizes

``` css
.btn-sm { padding: 6px 12px; }
.btn-md { padding: 12px 20px; }
.btn-lg { padding: 16px 28px; }
```

------------------------------------------------------------------------

## Tokens

``` yaml
cta:
  primary:
    bg: "#fbbf24"
    text: "#1f2933"
  danger:
    bg: "#dc2626"
```
