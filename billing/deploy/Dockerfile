# The billing service, for Fly.io (see README.md here). The build gets only the billing code: deploy.sh stages it.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir gunicorn==23.0.0 && useradd --create-home app
WORKDIR /app
COPY billing/ billing/
COPY start.sh billing-admin /usr/local/bin/
EXPOSE 8080
CMD ["start.sh"]
