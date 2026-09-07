# viajes-auth — tiny session gate (not the PWA).
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/viajes-auth .

FROM alpine:3.20
RUN adduser -D -H -u 10001 auth
USER auth
COPY --from=build /out/viajes-auth /usr/local/bin/viajes-auth
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/viajes-auth"]
